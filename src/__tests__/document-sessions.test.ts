import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentNotReadyError, DocumentSessions, DocumentWriterDisposedError, PendingDocumentChangesError, PARENT_RECORD_NOT_FOUND_ERROR_CODE } from '../enbox/index.js';
import type { DocumentPersistence, DocumentSessionsOptions, DurableDocumentUpdate, OpenDocumentSessionOptions } from '../enbox/index.js';
import { encodeEnvelope } from '../index.js';
import { createYjs1Doc } from '../yjs1/index.js';

const timers = { idleMs: 20, backstopMs: 200, convergenceMs: 10 };
const timestamp = '2026-10-29T00:00:00.000000Z';
type Document = ReturnType<typeof createYjs1Doc>;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function update(text: string): DurableDocumentUpdate {
  const doc = createYjs1Doc();
  doc.insertText(0, text);
  const data = doc.encodeFullState();
  doc.destroy();
  return { data, recordId: 'seed', messageTimestamp: timestamp };
}

function frameText(frame: Uint8Array): string {
  const doc = createYjs1Doc();
  try {
    expect(doc.applyLive(frame).applied).toBe(true);
    return doc.getText();
  } finally { doc.destroy(); }
}

function fixture(persistence?: DocumentSessionsOptions<Document>['persistence']) {
  const create = vi.fn<OpenDocumentSessionOptions['create']>(async () => ({ id: 'written', timestamp }));
  const onError = vi.fn();
  const onParentGone = vi.fn();
  const onLifecycle = vi.fn();
  const createDocument = vi.fn(() => createYjs1Doc());
  const sessions = new DocumentSessions({ createDocument, timers, persistence, onError, onLifecycle, onParentGone });
  const open = (options: Partial<OpenDocumentSessionOptions> = {}) =>
    sessions.open('page', { create, writable: true, canSquash: false, ...options });
  return { sessions, createDocument, create, onError, onLifecycle, onParentGone, open };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('document ownership', () => {
  it('coalesces hydration without exposing an empty document, then schedules local edits once', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const pending = deferred<readonly DurableDocumentUpdate[]>();
    const load = vi.fn(() => pending.promise);
    const readonlyCreate = vi.fn(async () => ({ id: 'readonly', timestamp }));
    const freshCreate = vi.fn(async () => ({ id: 'fresh', timestamp }));
    const first = test.open({ load });
    const second = test.open({ load, create: readonlyCreate, writable: false });
    const third = test.open({ load, create: freshCreate });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(test.sessions.get('page')).toBeUndefined();
    expect([...test.sessions.values()]).toEqual([]);
    pending.resolve([update('seed')]);
    const session = await first;
    expect(await second).toBe(session);
    expect(await third).toBe(session);
    expect(test.createDocument).toHaveBeenCalledOnce();
    expect(Object.keys(session).sort()).toEqual(['applyDurable', 'doc', 'setTimers']);
    expect(session.doc.getText()).toBe('seed');
    expect(test.onLifecycle.mock.calls.map(([event]) => event.phase)).toEqual(['opened']);
    session.setTimers({ idleMs: 20 });
    session.doc.insertText(4, ' edit');
    await vi.advanceTimersByTimeAsync(20);
    expect(freshCreate).toHaveBeenCalledOnce();
    expect(readonlyCreate).not.toHaveBeenCalled();
    expect(test.create).not.toHaveBeenCalled();
    await test.sessions.dispose();
  });

  it('joins pending hydration when closing', async () => {
    const test = fixture();
    const pending = deferred<readonly DurableDocumentUpdate[]>();
    const opening = test.open({ load: () => pending.promise });
    const closing = test.sessions.close('page');
    pending.resolve([]);
    const session = await opening;
    await closing;
    expect(test.sessions.get('page')).toBeUndefined();
    expect(() => session.doc.getText()).toThrow('destroyed');
    await test.sessions.dispose();
  });

  it('reclaims an open-close-open while hydration is pending', async () => {
    const test = fixture();
    const pending = deferred<readonly DurableDocumentUpdate[]>();
    const opening = test.open({ load: () => pending.promise });
    const closing = test.sessions.close('page');
    const reopened = test.open();
    pending.resolve([update('keep')]);
    const session = await reopened;
    expect(await opening).toBe(session);
    await closing;
    expect(test.sessions.get('page')).toBe(session);
    expect(session.doc.getText()).toBe('keep');
    await test.sessions.dispose();
  });

  it('retains a failed close, reclaims its exact handle and retries with fresh authority', async () => {
    const test = fixture();
    const failure = new Error('offline');
    test.create.mockRejectedValueOnce(failure);
    const session = await test.open();
    session.doc.insertText(0, 'retained');
    await expect(test.sessions.close('page')).rejects.toBe(failure);
    expect(test.onError).toHaveBeenCalledExactlyOnceWith('page', failure);
    expect(test.sessions.get('page')).toBe(session);
    const create = vi.fn(async () => ({ id: 'fresh', timestamp }));
    expect(await test.open({ create })).toBe(session);
    await test.sessions.close('page');
    expect(create).toHaveBeenCalledOnce();
    expect(test.sessions.get('page')).toBeUndefined();
    expect(test.onLifecycle.mock.calls.map(([event]) => event.phase))
      .toEqual(['opened', 'closing', 'opened', 'closing', 'disposed']);
    await test.sessions.dispose();
  });

  it('fences discard during an accepted write and a separate pending hydration', async () => {
    const test = fixture();
    const accepted = deferred<{ id: string; timestamp: string }>();
    test.create.mockImplementationOnce(() => accepted.promise);
    const session = await test.open();
    session.doc.insertText(0, 'accepted');
    const draining = test.sessions.drain('page');
    await vi.waitFor(() => expect(test.create).toHaveBeenCalledOnce());
    await test.sessions.discard('page');
    accepted.resolve({ id: 'accepted', timestamp });
    await draining;
    expect(() => session.doc.getText()).toThrow('destroyed');
    const load = deferred<readonly DurableDocumentUpdate[]>();
    const opening = test.open({ load: () => load.promise });
    await vi.waitFor(() => expect(test.createDocument).toHaveBeenCalledTimes(2));
    await test.sessions.discard('page');
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    load.resolve([update('late')]);
    expect(test.sessions.get('page')).toBeUndefined();
    await test.sessions.dispose();
  });

  it.each(['load failure', 'malformed initial update'] as const)('cleans up %s without publishing an unopened session', async failure => {
    const test = fixture();
    try {
      const opening = failure === 'load failure'
        ? test.open({ load: async () => { throw new Error('load failed'); } })
        : test.open({ updates: [{ data: new Uint8Array([0]) }] });
      await expect(opening).rejects.toThrow();
      expect(test.sessions.get('page')).toBeUndefined();
      expect(test.onLifecycle).not.toHaveBeenCalled();
      expect(() => test.createDocument.mock.results[0]!.value.getText()).toThrow('destroyed');
      const session = await test.open({ updates: [update('valid')] });
      expect(session.doc.getText()).toBe('valid');
      expect(test.onLifecycle.mock.calls.map(([event]) => event.phase)).toEqual(['opened']);
    } finally {
      await test.sessions.dispose();
    }
  });

  it('does not let an older drain-all finalize a newly started close', async () => {
    const test = fixture();
    const accepted = deferred<{ id: string; timestamp: string }>();
    test.create.mockImplementationOnce(() => accepted.promise);
    const session = await test.open();
    const all = test.sessions.drainAll();
    await Promise.resolve();
    session.doc.insertText(0, 'new close');
    const closing = test.sessions.close('page');
    await vi.waitFor(() => expect(test.create).toHaveBeenCalledOnce());
    await all;
    expect(test.sessions.get('page')).toBe(session);
    accepted.resolve({ id: 'saved', timestamp });
    await closing;
    expect(test.sessions.get('page')).toBeUndefined();
    await test.sessions.dispose();
  });
});

describe('document recovery', () => {
  it('rejects recovery without a configured adapter before allocating a document', async () => {
    const test = fixture();
    await expect(test.open({ recover: true })).rejects.toThrow('configured persistence');
    expect(test.createDocument).not.toHaveBeenCalled();
    await test.sessions.dispose();
  });

  it('retains recovered bytes when the native parent disappears during the initial save', async () => {
    const test = fixture((_key, doc) => {
      doc.insertText(0, 'recovered cache');
      return { whenSynced: Promise.resolve(), destroy: vi.fn() };
    });
    const failure = Object.assign(new Error('parent gone'), {
      status: { code: 400, errorCode: PARENT_RECORD_NOT_FOUND_ERROR_CODE },
    });
    test.create.mockRejectedValueOnce(failure);
    try {
      await expect(test.open({ recover: true })).rejects.toBe(failure);
      expect(test.onParentGone).toHaveBeenCalledExactlyOnceWith('page');
      expect(frameText(test.sessions.capturePending()[0]!.update)).toBe('recovered cache');
      await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(DocumentWriterDisposedError);
      expect(test.onLifecycle).not.toHaveBeenCalled();
    } finally { await test.sessions.dispose(); }
  });

  it.each(['pending', 'failed'] as const)('captures readonly local edits while recovery is %s without capturing live traffic alone', async state => {
    const synced = deferred<void>();
    const failure = new Error('cache failed');
    const persistence = vi.fn(() => ({ whenSynced: synced.promise, destroy: vi.fn() }));
    const test = fixture(persistence);
    const opening = test.open({ writable: false, recover: true });
    const settled = opening.catch(error => error);
    try {
      await vi.waitFor(() => expect(persistence).toHaveBeenCalledOnce());
      const session = test.sessions.get('page')!;
      session.doc.applyLive(update('peer live').data);
      expect(test.sessions.capturePending()).toEqual([]);
      if (state === 'failed') { synced.reject(failure); expect(await settled).toBe(failure); }
      session.doc.insertText(session.doc.getText().length, ' readonly draft');
      const pending = test.sessions.capturePending();
      expect(pending).toHaveLength(1);
      expect(frameText(pending[0]!.update)).toContain('readonly draft');
      expect(test.sessions.hasPending()).toBe(true);
      expect(test.create).not.toHaveBeenCalled();
      expect(test.sessions.get('page')).toBe(session);
      if (state === 'failed') await expect(test.sessions.close('page')).rejects.toBeInstanceOf(DocumentNotReadyError);
    } finally { synced.resolve(); await settled; await test.sessions.dispose(); }
  });

  it('upgrades a headless document once, drains recovery strictly and resumes one local listener', async () => {
    vi.useFakeTimers();
    const synced = deferred<void>();
    const persistence = vi.fn((_key: string, _doc: Document, _signal: AbortSignal) => ({ whenSynced: synced.promise, destroy: vi.fn() }));
    const test = fixture(persistence);
    const session = await test.open();
    expect(persistence).not.toHaveBeenCalled();
    const opening = test.open({ recover: true });
    await vi.waitFor(() => expect(persistence).toHaveBeenCalledOnce());
    expect(persistence.mock.calls[0]![0]).toBe('page');
    expect(persistence.mock.calls[0]![1]).toBe(session.doc);
    session.doc.insertText(0, 'cache');
    await vi.advanceTimersByTimeAsync(100);
    expect(test.create).not.toHaveBeenCalled();
    synced.resolve();
    expect(await opening).toBe(session);
    expect(test.create).toHaveBeenCalledOnce();
    expect(session.doc.hasUnflushedChanges()).toBe(false);
    await test.open({ recover: true });
    expect(persistence).toHaveBeenCalledOnce();
    session.doc.insertText(5, ' local');
    await vi.advanceTimersByTimeAsync(20);
    expect(test.create).toHaveBeenCalledTimes(2);
    await test.sessions.dispose();
    expect(persistence.mock.results[0]!.value.destroy).toHaveBeenCalledOnce();
    expect(persistence.mock.calls[0]![2].aborted).toBe(true);
  });

  it('honors recovery requested while the initial hydration is pending', async () => {
    const load = deferred<readonly DurableDocumentUpdate[]>();
    const synced = deferred<void>();
    const persistence = vi.fn(() => ({ whenSynced: synced.promise, destroy: vi.fn() }));
    const test = fixture(persistence);
    const first = test.open({ load: () => load.promise });
    const upgraded = test.open({ recover: true });
    load.resolve([]);
    await vi.waitFor(() => expect(persistence).toHaveBeenCalledOnce());
    test.sessions.get('page')!.doc.insertText(0, 'recovered');
    synced.resolve();
    expect(await first).toBe(await upgraded);
    expect(test.create).toHaveBeenCalledOnce();
    await test.sessions.dispose();
  });

  it('retains staged and cached state after a failed strict write and reuses the synced adapter', async () => {
    const persistence = vi.fn((_key: string, doc: Document) => {
      doc.insertText(0, 'cache');
      return { whenSynced: Promise.resolve(), destroy: vi.fn() };
    });
    const test = fixture(persistence);
    const failure = new Error('offline recovery');
    test.sessions.stage('page', update('repair').data);
    test.create.mockRejectedValueOnce(failure);
    await expect(test.open({ recover: true })).rejects.toBe(failure);
    const retained = test.sessions.get('page')!;
    expect(retained.doc.getText()).toContain('cache');
    expect(retained.doc.getText()).toContain('repair');
    expect(test.sessions.hasPending()).toBe(true);
    expect(await test.open({ recover: true })).toBe(retained);
    expect(persistence).toHaveBeenCalledOnce();
    expect(test.create).toHaveBeenCalledTimes(2);
    await test.sessions.dispose();
  });

  it.each(['attach', 'sync'] as const)('retries the configured adapter after failed %s without losing recovered operations', async phase => {
    const failure = new Error('cache failed');
    const destroy = vi.fn();
    const persistence = vi.fn<(_key: string, doc: Document) => Promise<DocumentPersistence>>()
      .mockImplementationOnce(async (_key, doc) => {
        doc.insertText(0, 'retained');
        if (phase === 'attach') throw failure;
        return { whenSynced: Promise.reject(failure), destroy };
      })
      .mockResolvedValue({ whenSynced: Promise.resolve(), destroy: vi.fn() });
    const test = fixture(persistence);
    await expect(test.open({ recover: true })).rejects.toBe(failure);
    expect(test.sessions.get('page')!.doc.getText()).toBe('retained');
    await test.open({ recover: true });
    expect(persistence).toHaveBeenCalledTimes(2);
    expect(test.create).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledTimes(phase === 'sync' ? 1 : 0);
    await test.sessions.dispose();
  });

  it('fences disposal immediately and awaits a late adapter and its asynchronous cleanup', async () => {
    const attached = deferred<DocumentPersistence>();
    const cleaned = deferred<void>();
    const destroy = vi.fn(() => cleaned.promise);
    const persistence = vi.fn(() => attached.promise);
    const test = fixture(persistence);
    const opening = test.open({ recover: true });
    await vi.waitFor(() => expect(persistence).toHaveBeenCalledOnce());
    const session = test.sessions.get('page')!;
    const disposal = test.sessions.dispose();
    expect(test.sessions.get('page')).toBeUndefined();
    expect(() => session.doc.getText()).toThrow('destroyed');
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    attached.resolve({ whenSynced: Promise.resolve(), destroy });
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    let disposed = false;
    void disposal.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    cleaned.resolve();
    await disposal;
  });

  it('waits for recovery before closing and deletes a cache only when explicitly discarded', async () => {
    const synced = deferred<void>();
    const persistence = { whenSynced: synced.promise, destroy: vi.fn(), clearData: vi.fn() };
    const test = fixture(() => persistence);
    const opening = test.open({ recover: true });
    const closing = test.sessions.close('page');
    synced.resolve();
    await opening;
    await closing;
    expect(persistence.destroy).toHaveBeenCalledOnce();
    expect(persistence.clearData).not.toHaveBeenCalled();
    await test.open({ recover: true });
    await test.sessions.discard('page', { clearPersistence: true });
    expect(persistence.clearData).toHaveBeenCalledOnce();
    await test.sessions.dispose();
  });

  it('settles all cleanup and destroys the document even when adapter cleanup rejects', async () => {
    const cleaned = deferred<void>();
    const test = fixture(() => ({ whenSynced: Promise.resolve(), destroy: () => cleaned.promise }));
    const failure = new Error('cache close failed');
    const session = await test.open({ recover: true });
    const disposal = test.sessions.dispose();
    expect(() => session.doc.getText()).toThrow('destroyed');
    cleaned.reject(failure);
    await expect(disposal).rejects.toMatchObject({ errors: [failure] });
    expect(test.sessions.dispose()).toBe(disposal);
  });

  it('includes a prior asynchronous discard in disposal', async () => {
    const cleaned = deferred<void>();
    const destroy = vi.fn(() => cleaned.promise);
    const test = fixture(() => ({ whenSynced: Promise.resolve(), destroy }));
    await test.open({ recover: true });
    const discarded = test.sessions.discard('page');
    const disposed = test.sessions.dispose();
    let settled = false;
    void disposed.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
    cleaned.resolve();
    await Promise.all([discarded, disposed]);
  });

  it('publishes one disposal promise before lifecycle callbacks can reenter', async () => {
    const cleaned = deferred<void>();
    const test = fixture(() => ({ whenSynced: Promise.resolve(), destroy: () => cleaned.promise }));
    let reentrant: Promise<void> | undefined;
    test.onLifecycle.mockImplementation(({ phase }) => {
      if (phase === 'disposed') reentrant = test.sessions.dispose();
    });
    const session = await test.open({ recover: true });
    const disposal = test.sessions.dispose();
    expect(reentrant).toBe(disposal);
    expect(() => session.doc.getText()).toThrow('destroyed');
    cleaned.resolve();
    await disposal;
  });
});

describe('document authority and repair', () => {
  it('stages only before opening and preserves the original repair through failed hydration', async () => {
    const test = fixture();
    const repair = update('repair').data;
    const replacement = update('replacement').data;
    const load = deferred<readonly DurableDocumentUpdate[]>();
    test.sessions.stage('page', repair);
    const opening = test.open({ load: () => load.promise });
    const failure = new Error('load failed');
    const rejected = expect(opening).rejects.toBe(failure);
    try {
      expect(() => test.sessions.stage('page', replacement)).toThrow('before opening');
      expect(test.sessions.get('page')).toBeUndefined();
      expect([...test.sessions.values()]).toEqual([]);
      expect(test.sessions.capturePending()).toEqual([{ key: 'page', update: repair }]);
      load.reject(failure);
      await rejected;
      expect(test.sessions.capturePending()).toEqual([{ key: 'page', update: repair }]);
      const session = await test.open();
      expect(() => test.sessions.stage('page', replacement)).toThrow('before opening');
      test.create.mockRejectedValueOnce(failure);
      await expect(test.sessions.close('page')).rejects.toBe(failure);
      expect(() => test.sessions.stage('page', replacement)).toThrow('before opening');
      expect(test.sessions.get('page')).toBe(session);
      expect(session.doc.getText()).toBe('repair');
    } finally {
      load.reject(failure);
      await opening.catch(() => {});
      await test.sessions.dispose();
    }
  });

  it('consumes a readonly initial repair and clears pending state when durable confirmation arrives', async () => {
    const test = fixture();
    const repair = update('repair');
    test.sessions.stage('page', repair.data);
    const session = await test.open({ writable: false });
    expect(test.sessions.hasPending()).toBe(true);
    await expect(test.sessions.close('page')).rejects.toBeInstanceOf(PendingDocumentChangesError);
    session.applyDurable(repair.data, { recordId: repair.recordId });
    expect(test.sessions.hasPending()).toBe(false);
    expect(test.sessions.capturePending()).toEqual([]);
    await test.sessions.drainAll();
    expect(test.sessions.get('page')).toBeUndefined();
    expect(test.create).not.toHaveBeenCalled();
    await test.sessions.dispose();
  });

  it.each([true, false])('retains parent-gone changes with writable=%s until explicit handoff', async writable => {
    const test = fixture();
    const fresh = fixture();
    const accepted = deferred<{ id: string; timestamp: string }>();
    const failure = Object.assign(new Error('parent gone'), {
      status: { code: 400, errorCode: PARENT_RECORD_NOT_FOUND_ERROR_CODE },
    });
    let stopping: Promise<void> | undefined;
    try {
      const session = await test.open({ updates: [update('durable baseline')] });
      session.doc.insertText(session.doc.getText().length, ' retained');
      test.create.mockImplementationOnce(() => accepted.promise);
      stopping = test.sessions.drain('page');
      const rejected = expect(stopping).rejects.toBe(failure);
      await vi.waitFor(() => expect(test.create).toHaveBeenCalledOnce());
      if (!writable) await test.open({ writable: false });
      accepted.reject(failure);
      await rejected;
      expect(test.onParentGone).toHaveBeenCalledExactlyOnceWith('page');
      session.doc.insertText(session.doc.getText().length, ' after stop');
      expect(test.sessions.hasPending()).toBe(true);
      const captured = test.sessions.capturePending();
      expect(captured).toHaveLength(1);
      expect(frameText(captured[0]!.update)).toBe('durable baseline retained after stop');
      await expect(test.sessions.drain('page')).rejects.toBeInstanceOf(DocumentWriterDisposedError);
      await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(DocumentWriterDisposedError);
      await expect(test.sessions.close('page')).rejects.toBeInstanceOf(DocumentWriterDisposedError);
      await expect(test.open({ writable })).rejects.toBeInstanceOf(DocumentWriterDisposedError);
      expect(test.sessions.get('page')).toBe(session);
      expect(test.create).toHaveBeenCalledOnce();
      fresh.sessions.stage('page', captured[0]!.update);
      const recovered = await fresh.open();
      await fresh.sessions.drainAll();
      expect(recovered.doc.getText()).toBe('durable baseline retained after stop');
      expect(fresh.sessions.hasPending()).toBe(false);
      await test.sessions.discard('page');
      expect(test.sessions.hasPending()).toBe(false);
    } finally {
      if (stopping !== undefined) { accepted.reject(failure); await stopping.catch(() => {}); }
      await Promise.all([test.sessions.dispose(), fresh.sessions.dispose()]);
    }
  });



  it('returns a rejected open promise when demotion capture fails and still denies readonly writes', async () => {
    const test = fixture();
    try {
      const session = await test.open();
      session.doc.insertText(0, 'retained local');
      const failure = new Error('capture failed');
      vi.spyOn(session.doc, 'planRepublish').mockImplementationOnce(() => { throw failure; });
      let opening: ReturnType<typeof test.open> | undefined;
      expect(() => { opening = test.open({ writable: false }); }).not.toThrow();
      await expect(opening).rejects.toBe(failure);
      expect(test.sessions.get('page')).toBe(session);
      expect(session.doc.getText()).toBe('retained local');
      await expect(test.sessions.drain('page')).rejects.toThrow();
      expect(test.create).not.toHaveBeenCalled();
    } finally {
      await test.sessions.dispose();
    }
  });

  it('retains a validated repair when its initial application fails and permits fresh hydration', async () => {
    const test = fixture();
    const repair = update('staged repair');
    test.sessions.stage('page', repair.data);
    const failedDoc = createYjs1Doc();
    vi.spyOn(failedDoc, 'applyLive').mockReturnValue({ applied: false, reason: 'invalid-payload' });
    test.createDocument.mockReturnValueOnce(failedDoc);
    try {
      await expect(test.open({ updates: [update('baseline')] })).rejects.toThrow('restore document changes');
      expect(test.sessions.get('page')).toBeUndefined();
      expect([...test.sessions.values()]).toEqual([]);
      expect(test.onLifecycle).not.toHaveBeenCalled();
      expect(() => failedDoc.getText()).toThrow('destroyed');
      expect(test.sessions.capturePending()).toEqual([{ key: 'page', update: repair.data }]);
      const session = await test.open({ updates: [update('baseline')] });
      expect(session.doc.getText()).toContain('baseline');
      expect(session.doc.getText()).toContain('staged repair');
      await test.sessions.drainAll();
      expect(test.sessions.hasPending()).toBe(false);
    } finally { await test.sessions.dispose(); }
  });

  it.each(['drain', 'close', 'pending close'] as const)('preserves acknowledged edits across %s after demotion', async barrier => {
    const test = fixture();
    const accepted = deferred<{ id: string; timestamp: string }>();
    test.create.mockImplementationOnce(() => accepted.promise);
    const session = await test.open();
    session.doc.insertText(0, 'accepted');
    const draining = barrier === 'drain' ? test.sessions.drain('page') : test.sessions.flush('page');
    await vi.waitFor(() => expect(test.create).toHaveBeenCalledOnce());
    await test.open({ writable: false });
    expect(test.sessions.hasPending()).toBe(true);
    if (barrier === 'pending close') {
      await expect(test.sessions.close('page')).rejects.toBeInstanceOf(PendingDocumentChangesError);
      expect(test.sessions.get('page')).toBe(session);
      expect(session.doc.getText()).toBe('accepted');
      await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(PendingDocumentChangesError);
      expect(test.sessions.get('page')).toBe(session);
    }
    accepted.resolve({ id: 'accepted', timestamp });
    await draining;
    expect(session.doc.hasUnflushedChanges()).toBe(false);
    if (barrier === 'close') await test.sessions.close('page');
    expect(test.sessions.hasPending()).toBe(false);
    await test.sessions.drainAll();
    if (barrier === 'pending close') expect(test.sessions.get('page')).toBeUndefined();
    await test.sessions.dispose();
  });


  it('retains cache recovery merged after a readonly rebind and never writes through readonly authority', async () => {
    const synced = deferred<void>();
    const persistence = vi.fn(() => ({ whenSynced: synced.promise, destroy: vi.fn() }));
    const test = fixture(persistence);
    const opening = test.open({ recover: true });
    await vi.waitFor(() => expect(persistence).toHaveBeenCalledOnce());
    const session = test.sessions.get('page')!;
    const demoted = test.open({ writable: false });
    session.doc.insertText(0, 'late cache');
    synced.resolve();
    await opening;
    await demoted;
    expect(test.create).not.toHaveBeenCalled();
    expect(test.sessions.hasPending()).toBe(true);
    await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(PendingDocumentChangesError);
    await expect(test.sessions.close('page')).rejects.toBeInstanceOf(PendingDocumentChangesError);
    expect(test.sessions.get('page')).toBe(session);
    expect(test.sessions.capturePending()).toHaveLength(1);
    await test.sessions.dispose();
  });

  it.each([false, true])('reports unresolved recovery separately from pending access when writable=%s', async writable => {
    const failure = new Error('cache unreadable');
    const test = fixture(async () => { throw failure; });
    try {
      await expect(test.open({ writable, recover: true })).rejects.toBe(failure);
      const session = test.sessions.get('page');
      expect(session).toBeDefined();
      expect(test.sessions.hasPending()).toBe(false);
      await expect(test.sessions.drain('page')).rejects.toBeInstanceOf(DocumentNotReadyError);
      await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(DocumentNotReadyError);
      await expect(test.sessions.close('page')).rejects.toBeInstanceOf(DocumentNotReadyError);
      expect(test.sessions.get('page')).toBe(session);
      expect(test.create).not.toHaveBeenCalled();
    } finally {
      await test.sessions.dispose();
    }
  });

  it.each(['local', 'live'] as const)('retains a writable %s residual through demotion, then uses fresh authority after rebind', async origin => {
    vi.useFakeTimers();
    const test = fixture();
    const session = await test.open();
    if (origin === 'local') session.doc.insertText(0, 'edit');
    else session.doc.applyLive(update('edit').data);
    await test.open({ writable: false });
    await vi.advanceTimersByTimeAsync(200);
    await test.sessions.flush('page');
    await expect(test.sessions.drain('page')).rejects.toBeInstanceOf(PendingDocumentChangesError);
    await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(PendingDocumentChangesError);
    expect(test.sessions.capturePending()).toHaveLength(1);
    expect(test.create).not.toHaveBeenCalled();
    const create = vi.fn(async () => ({ id: 'fresh', timestamp }));
    expect(await test.open({ create })).toBe(session);
    await test.sessions.drain('page');
    expect(create).toHaveBeenCalledOnce();
    expect(test.sessions.hasPending()).toBe(false);
    await test.sessions.dispose();
  });

  it('does not turn an always-readonly live residual into staged changes or native writes', async () => {
    const test = fixture();
    const session = await test.open({ writable: false });
    session.doc.applyLive(update('remote live').data);
    await test.open({ writable: false });
    const capture = vi.spyOn(session.doc, 'planRepublish');
    expect(test.sessions.hasPending()).toBe(false);
    expect(test.sessions.capturePending()).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
    await test.sessions.drainAll();
    await test.sessions.close('page');
    expect(test.create).not.toHaveBeenCalled();
    await test.sessions.dispose();
  });

  it.each(['grant', 'discard'] as const)('retains local edits made while readonly until an explicit %s', async action => {
    vi.useFakeTimers();
    const test = fixture();
    try {
      const session = await test.open({ writable: false });
      session.doc.insertText(0, 'readonly local edit');
      await vi.advanceTimersByTimeAsync(200);
      expect(test.create).not.toHaveBeenCalled();
      expect(test.sessions.hasPending()).toBe(true);
      expect(test.sessions.capturePending()).toHaveLength(1);
      await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(PendingDocumentChangesError);
      await expect(test.sessions.close('page')).rejects.toBeInstanceOf(PendingDocumentChangesError);
      expect(test.sessions.get('page')).toBe(session);
      expect(session.doc.getText()).toBe('readonly local edit');
      if (action === 'grant') {
        const create = vi.fn(async () => ({ id: 'fresh', timestamp }));
        expect(await test.open({ create })).toBe(session);
        await test.sessions.drainAll();
        expect(create).toHaveBeenCalledOnce();
        expect(test.create).not.toHaveBeenCalled();
        await test.sessions.close('page');
      } else {
        await test.sessions.discard('page');
        expect(test.create).not.toHaveBeenCalled();
      }
      expect(test.sessions.hasPending()).toBe(false);
      expect(test.sessions.get('page')).toBeUndefined();
    } finally {
      await test.sessions.dispose();
    }
  });

  it('retains a readonly local edit made by a closing notification', async () => {
    const test = fixture();
    try {
      const session = await test.open({ writable: false });
      test.onLifecycle.mockImplementation(({ phase, session: current }) => {
        if (phase === 'closing') current.doc.insertText(0, 'closing edit');
      });
      await expect(test.sessions.close('page')).rejects.toBeInstanceOf(PendingDocumentChangesError);
      expect(test.sessions.get('page')).toBe(session);
      expect(session.doc.getText()).toBe('closing edit');
      const pending = test.sessions.capturePending();
      expect(pending).toHaveLength(1);
      expect(frameText(pending[0]!.update)).toBe('closing edit');
      expect(test.create).not.toHaveBeenCalled();
    } finally {
      await test.sessions.dispose();
    }
  });

  it('retains an initial readonly repair and later local edits through handoff and regrant', async () => {
    const test = fixture();
    const persisted = createYjs1Doc();
    try {
      test.sessions.stage('page', update('staged repair').data);
      const session = await test.open({ writable: false });
      expect(session.doc.getText()).toBe('staged repair');
      await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(PendingDocumentChangesError);
      expect(test.create).not.toHaveBeenCalled();
      session.doc.applyLive(update('peer live').data);
      session.doc.insertText(0, 'new local');
      const captured = test.sessions.capturePending();
      expect(captured).toHaveLength(1);
      const text = frameText(captured[0]!.update);
      expect(text).toContain('staged repair');
      expect(text).toContain('new local');
      expect(text).toContain('peer live');
      await expect(test.sessions.close('page')).rejects.toBeInstanceOf(PendingDocumentChangesError);
      expect(test.sessions.get('page')).toBe(session);
      const create = vi.fn<OpenDocumentSessionOptions['create']>(async request => {
        persisted.applyDurable(request.data);
        return { id: 'fresh', timestamp };
      });
      expect(await test.open({ create })).toBe(session);
      await test.sessions.drainAll();
      expect(test.create).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();
      expect(persisted.getText()).toContain('staged repair');
      expect(persisted.getText()).toContain('new local');
      expect(persisted.getText()).toContain('peer live');
      expect(test.sessions.hasPending()).toBe(false);
    } finally {
      persisted.destroy();
      await test.sessions.dispose();
    }
  });

  it.each(['drain', 'close', 'drain all'] as const)('uses the public pending-changes error if access changes during %s', async barrier => {
    const test = fixture();
    const accepted = deferred<{ id: string; timestamp: string }>();
    test.create.mockImplementationOnce(() => accepted.promise);
    try {
      const session = await test.open();
      session.doc.insertText(0, 'first');
      const draining = barrier === 'drain' ? test.sessions.drain('page')
        : barrier === 'close' ? test.sessions.close('page') : test.sessions.drainAll();
      const rejected = expect(draining).rejects.toBeInstanceOf(PendingDocumentChangesError);
      await vi.waitFor(() => expect(test.create).toHaveBeenCalledOnce());
      session.doc.insertText(5, ' later');
      await test.open({ writable: false });
      accepted.resolve({ id: 'first', timestamp });
      await rejected;
      expect(test.onError).not.toHaveBeenCalled();
      expect(test.sessions.get('page')).toBe(session);
      expect(test.sessions.hasPending()).toBe(true);
      const create = vi.fn(async () => ({ id: 'fresh', timestamp }));
      await test.open({ create });
      await test.sessions.drainAll();
      expect(create).toHaveBeenCalledOnce();
      expect(test.create).toHaveBeenCalledOnce();
      expect(test.sessions.hasPending()).toBe(false);
    } finally {
      accepted.resolve({ id: 'first', timestamp });
      await test.sessions.dispose();
    }
  });

  it.each([
    ['bad header', new Uint8Array([0])],
    ['wrong format', encodeEnvelope('loro1', new Uint8Array([0, 0]))],
    ['corrupt payload', encodeEnvelope('yjs1', new Uint8Array([255]))],
  ] as const)('rejects a staged %s without replacing a valid repair', async (_reason, invalid) => {
    const test = fixture();
    try {
      test.sessions.stage('page', update('valid repair').data);
      const captured = test.sessions.capturePending();
      expect(() => test.sessions.stage('page', invalid)).toThrow();
      expect(test.sessions.capturePending()).toEqual(captured);
      expect(test.sessions.get('page')).toBeUndefined();
      const temporary = test.createDocument.mock.results.at(-1)!.value;
      expect(() => temporary.getText()).toThrow('destroyed');
      const session = await test.open();
      expect(session.doc.getText()).toContain('valid repair');
      await test.sessions.drainAll();
      expect(test.sessions.hasPending()).toBe(false);
    } finally {
      await test.sessions.dispose();
    }
  });


  it('rebinds durable snapshots through the existing convergence writer', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const session = await test.open();
    session.doc.insertText(0, 'local');
    await test.sessions.drain('page');
    test.create.mockClear();
    await test.open({ updates: [{ ...update('remote'), snapshot: true, messageTimestamp: '2026-10-29T00:00:01.000000Z' }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(test.create).toHaveBeenCalledOnce();
    expect(session.doc.getText()).toContain('local');
    expect(session.doc.getText()).toContain('remote');
    await test.sessions.dispose();
  });
});
