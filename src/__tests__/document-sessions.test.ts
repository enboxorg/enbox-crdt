import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentSessions, PendingDocumentChangesError } from '../enbox/index.js';
import type { DocumentPersistence, DurableDocumentUpdate, OpenDocumentSessionOptions } from '../enbox/index.js';
import { createYjs1Doc } from '../yjs1/index.js';
import { createAwareness } from '../yjs1/awareness.js';

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

function fixture() {
  const create = vi.fn<OpenDocumentSessionOptions<Document>['create']>(async () => ({ id: 'written', timestamp }));
  const onError = vi.fn();
  const onLifecycle = vi.fn();
  const createDocument = vi.fn(() => {
    const doc = createYjs1Doc();
    return { doc, awareness: createAwareness(doc) };
  });
  const sessions = new DocumentSessions({ createDocument, timers, onError, onLifecycle });
  const open = (options: Partial<OpenDocumentSessionOptions<Document>> = {}) =>
    sessions.open('page', { create, writable: true, canSquash: false, ...options });
  return { sessions, createDocument, create, onError, onLifecycle, open };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('document ownership', () => {
  it('coalesces hydration without exposing an empty document, then schedules local edits once', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const pending = deferred<readonly DurableDocumentUpdate[]>();
    const load = vi.fn(() => pending.promise);
    const first = test.open({ load });
    const second = test.open({ load });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(test.sessions.get('page')).toBeUndefined();
    expect([...test.sessions.values()]).toEqual([]);
    pending.resolve([update('seed')]);
    const session = await first;
    expect(await second).toBe(session);
    expect(test.createDocument).toHaveBeenCalledOnce();
    expect(session.doc.getText()).toBe('seed');
    expect(test.onLifecycle.mock.calls.map(([event]) => event.phase)).toEqual(['opened']);
    session.doc.insertText(4, ' edit');
    await vi.advanceTimersByTimeAsync(20);
    expect(test.create).toHaveBeenCalledOnce();
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

  it('cleans up malformed initial updates and allows a fresh open', async () => {
    const test = fixture();
    await expect(test.open({ updates: [{ data: new Uint8Array([0]) }] })).rejects.toThrow('durable document update');
    expect(test.sessions.get('page')).toBeUndefined();
    const session = await test.open({ updates: [update('valid')] });
    expect(session.doc.getText()).toBe('valid');
    await test.sessions.dispose();
  });

  it('does not let an older drain-all finalize a newly started close', async () => {
    const test = fixture();
    const session = await test.open();
    const drained = deferred<void>();
    const closed = deferred<void>();
    const drain = vi.spyOn(session.writer, 'drain')
      .mockImplementationOnce(() => drained.promise)
      .mockImplementationOnce(() => closed.promise);
    const all = test.sessions.drainAll();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    const closing = test.sessions.close('page');
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(2));
    drained.resolve();
    await all;
    expect(test.sessions.get('page')).toBe(session);
    expect(session.doc.getText()).toBe('');
    closed.resolve();
    await closing;
    expect(test.sessions.get('page')).toBeUndefined();
    await test.sessions.dispose();
  });
});

describe('document recovery', () => {
  it('upgrades a headless document once, waits for recovery, drains strictly and resumes one local listener', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const session = await test.open();
    const synced = deferred<void>();
    const persistence = vi.fn(() => ({ whenSynced: synced.promise, destroy: vi.fn() }));
    const opening = test.open({ persistence });
    await vi.waitFor(() => expect(persistence).toHaveBeenCalledOnce());
    session.doc.insertText(0, 'cache');
    await vi.advanceTimersByTimeAsync(100);
    expect(test.create).not.toHaveBeenCalled();
    synced.resolve();
    expect(await opening).toBe(session);
    expect(test.create).toHaveBeenCalledOnce();
    expect(session.doc.hasUnflushedChanges()).toBe(false);
    await test.open({ persistence });
    expect(persistence).toHaveBeenCalledOnce();
    session.doc.insertText(5, ' local');
    await vi.advanceTimersByTimeAsync(20);
    expect(test.create).toHaveBeenCalledTimes(2);
    await test.sessions.dispose();
    expect(persistence.mock.results[0]!.value.destroy).toHaveBeenCalledOnce();
  });

  it('honors a persistence upgrade requested during the first hydration', async () => {
    const test = fixture();
    const load = deferred<readonly DurableDocumentUpdate[]>();
    const synced = deferred<void>();
    const persistence = vi.fn(() => ({ whenSynced: synced.promise, destroy: vi.fn() }));
    const first = test.open({ load: () => load.promise });
    const upgraded = test.open({ persistence });
    load.resolve([]);
    await vi.waitFor(() => expect(persistence).toHaveBeenCalledOnce());
    const session = test.sessions.get('page')!;
    session.doc.insertText(0, 'recovered');
    synced.resolve();
    expect(await first).toBe(await upgraded);
    expect(test.create).toHaveBeenCalledOnce();
    await test.sessions.dispose();
  });

  it('retains recovered state after a failed strict write and reuses the synced adapter on retry', async () => {
    const test = fixture();
    const failure = new Error('offline recovery');
    test.create.mockRejectedValueOnce(failure);
    const persistence = vi.fn((doc: Document) => {
      doc.insertText(0, 'cache');
      return { whenSynced: Promise.resolve(), destroy: vi.fn() };
    });
    await expect(test.open({ persistence })).rejects.toBe(failure);
    const retained = test.sessions.get('page')!;
    expect(retained.doc.getText()).toBe('cache');
    expect(test.sessions.hasPending()).toBe(true);
    expect(await test.open({ persistence })).toBe(retained);
    expect(persistence).toHaveBeenCalledOnce();
    expect(test.create).toHaveBeenCalledTimes(2);
    await test.sessions.dispose();
  });

  it.each(['attach', 'sync'] as const)('retries a failed persistence %s without losing recovered operations', async phase => {
    const test = fixture();
    const failure = new Error('cache failed');
    const destroy = vi.fn();
    const persistence = vi.fn<(doc: Document) => Promise<DocumentPersistence>>()
      .mockImplementation(async doc => {
        doc.insertText(0, 'retained');
        if (phase === 'attach') throw failure;
        return { whenSynced: Promise.reject(failure), destroy };
      });
    await expect(test.open({ persistence })).rejects.toBe(failure);
    expect(test.sessions.get('page')!.doc.getText()).toBe('retained');
    const replacement = vi.fn(() => ({ whenSynced: Promise.resolve(), destroy: vi.fn() }));
    await test.open({ persistence: replacement });
    expect(persistence).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledOnce();
    expect(test.create).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledTimes(phase === 'sync' ? 1 : 0);
    await test.sessions.dispose();
  });

  it('fences disposal immediately and awaits a late adapter and its asynchronous cleanup', async () => {
    const test = fixture();
    const attached = deferred<DocumentPersistence>();
    const cleaned = deferred<void>();
    const destroy = vi.fn(() => cleaned.promise);
    const persistence = vi.fn(() => attached.promise);
    const opening = test.open({ persistence });
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
    const test = fixture();
    const synced = deferred<void>();
    const persistence = { whenSynced: synced.promise, destroy: vi.fn(), clearData: vi.fn() };
    const opening = test.open({ persistence: () => persistence });
    const closing = test.sessions.close('page');
    synced.resolve();
    await opening;
    await closing;
    expect(persistence.destroy).toHaveBeenCalledOnce();
    expect(persistence.clearData).not.toHaveBeenCalled();
    await test.open({ persistence: () => persistence });
    await test.sessions.discard('page', { clearPersistence: true });
    expect(persistence.clearData).toHaveBeenCalledOnce();
    await test.sessions.dispose();
  });

  it('settles all cleanup and destroys the document even when adapter cleanup rejects', async () => {
    const test = fixture();
    const failure = new Error('cache close failed');
    const cleaned = deferred<void>();
    const session = await test.open({ persistence: () => ({ whenSynced: Promise.resolve(), destroy: () => cleaned.promise }) });
    const disposal = test.sessions.dispose();
    expect(() => session.doc.getText()).toThrow('destroyed');
    cleaned.reject(failure);
    await expect(disposal).rejects.toMatchObject({ errors: [failure] });
    expect(test.sessions.dispose()).toBe(disposal);
  });

  it('includes a prior asynchronous discard in disposal', async () => {
    const test = fixture();
    const cleaned = deferred<void>();
    const destroy = vi.fn(() => cleaned.promise);
    await test.open({ persistence: () => ({ whenSynced: Promise.resolve(), destroy }) });
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
    const test = fixture();
    const cleaned = deferred<void>();
    let reentrant: Promise<void> | undefined;
    test.onLifecycle.mockImplementation(({ phase }) => {
      if (phase === 'disposed') reentrant = test.sessions.dispose();
    });
    const session = await test.open({ persistence: () => ({ whenSynced: Promise.resolve(), destroy: () => cleaned.promise }) });
    const disposal = test.sessions.dispose();
    expect(reentrant).toBe(disposal);
    expect(() => session.doc.getText()).toThrow('destroyed');
    cleaned.resolve();
    await disposal;
  });
});

describe('document authority and repair', () => {
  it.each(['drain', 'close'] as const)('clears an acknowledged demotion residual before %s completes', async barrier => {
    const test = fixture();
    const accepted = deferred<{ id: string; timestamp: string }>();
    test.create.mockImplementationOnce(() => accepted.promise);
    const session = await test.open();
    session.doc.insertText(0, 'accepted');
    const draining = barrier === 'drain' ? test.sessions.drain('page') : session.writer.flush();
    await vi.waitFor(() => expect(test.create).toHaveBeenCalledOnce());
    await test.open({ writable: false });
    expect(test.sessions.hasPending()).toBe(true);
    accepted.resolve({ id: 'accepted', timestamp });
    await draining;
    expect(session.doc.hasUnflushedChanges()).toBe(false);
    if (barrier === 'close') await test.sessions.close('page');
    expect(test.sessions.hasPending()).toBe(false);
    await test.sessions.drainAll();
    await test.sessions.dispose();
  });

  it('does not discard a staged frame that has not been applied to an existing clean document', async () => {
    const test = fixture();
    const session = await test.open({ writable: false });
    const staged = update('not yet merged');
    test.sessions.stage('page', staged.data);
    expect(session.doc.hasUnflushedChanges()).toBe(false);
    expect(test.sessions.capturePending()).toHaveLength(1);
    await expect(test.sessions.drain('page')).rejects.toBeInstanceOf(PendingDocumentChangesError);
    await test.open({ writable: false });
    session.writer.applyDurable(staged.data, { recordId: staged.recordId });
    expect(test.sessions.hasPending()).toBe(false);
    await test.sessions.drainAll();
    await test.sessions.dispose();
  });

  it('retains cache recovery merged after a readonly rebind and never writes through readonly authority', async () => {
    const test = fixture();
    const synced = deferred<void>();
    const persistence = vi.fn(() => ({ whenSynced: synced.promise, destroy: vi.fn() }));
    const opening = test.open({ persistence });
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
    await test.sessions.close('page');
    expect(test.sessions.capturePending()).toHaveLength(1);
    await test.sessions.dispose();
  });

  it('blocks readonly durability barriers when cache recovery is unresolved', async () => {
    const test = fixture();
    await expect(test.open({ writable: false, persistence: async () => { throw new Error('cache unreadable'); } }))
      .rejects.toThrow('cache unreadable');
    await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(PendingDocumentChangesError);
    expect(test.create).not.toHaveBeenCalled();
    await test.sessions.dispose();
  });

  it('retains pending edits through demotion without writing, then uses fresh authority after rebind', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const session = await test.open();
    session.doc.insertText(0, 'edit');
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
    expect(test.sessions.hasPending()).toBe(false);
    await test.sessions.drainAll();
    await test.sessions.close('page');
    expect(test.create).not.toHaveBeenCalled();
    await test.sessions.dispose();
  });

  it('retains staged edits with read-only access and drains them only after a writable rebind', async () => {
    const test = fixture();
    test.sessions.stage('page', update('repair').data);
    const session = await test.open({ writable: false });
    expect(session.doc.getText()).toBe('repair');
    await expect(test.sessions.drainAll()).rejects.toBeInstanceOf(PendingDocumentChangesError);
    expect(test.create).not.toHaveBeenCalled();
    expect(test.sessions.capturePending()).toHaveLength(1);
    await test.open();
    await test.sessions.drainAll();
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.sessions.hasPending()).toBe(false);
    await test.sessions.dispose();
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
