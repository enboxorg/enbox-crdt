import type { CollabDoc, DurableDeltaMeta } from '../collab-doc.js';
import type { DurableWriterClock, DurableWriterOptions, DurableWriterTimers } from './durable-writer.js';

import { DurableWriter, notify } from './durable-writer.js';

/** One durable CRDT frame with metadata supplied by its storage adapter. */
export interface DurableDocumentUpdate extends DurableDeltaMeta {
  data: Uint8Array;
}

/**
 * Local persistence: whenSynced is the initial recovery barrier. Later cache
 * merges enter the document's local-update feed and are saved or retained under
 * its current write policy. Network records/frames must use applyDurable/applyLive.
 */
export interface DocumentPersistence {
  readonly whenSynced: Promise<void>;
  /** Idempotently detach; repeated calls share any asynchronous cleanup. */
  destroy(): void | Promise<void>;
  /** Idempotently detach and delete this adapter's stored data. */
  clearData?(): void | Promise<void>;
}

/** One stable document handle; the owner retains writer and lifetime control. */
export interface DocumentSession<Document extends CollabDoc> {
  readonly doc: Document;
  /** Apply a stored frame through the existing convergence writer. */
  readonly applyDurable: DurableWriter['applyDurable'];
  /** Change the cadence used for subsequently scheduled writes. */
  readonly setTimers: DurableWriter['setTimers'];
}

/** Native write authority and optional hydration/recovery for one logical document. */
export interface OpenDocumentSessionOptions {
  create: DurableWriterOptions['create'];
  /** Gates native writes; local mutations remain possible and are retained while false. */
  writable: boolean;
  canSquash: boolean;
  /** Queried only when creating the document, with an owner-controlled lifetime signal. */
  load?(signal: AbortSignal): Promise<readonly DurableDocumentUpdate[]>;
  /** Already-loaded records applied on every open, including an authority rebind. */
  updates?: readonly DurableDocumentUpdate[];
  /** Request the configured persistence adapter, including for a headless document already open. */
  recover?: boolean;
}

/**
 * Notifications, not a complete state machine. Closing announces an attempt;
 * its promise may reject while the handle remains retained. Disposed means
 * ownership is fenced; the operation's promise awaits adapter cleanup.
 * Failed initial opens emit none.
 */
export interface DocumentLifecycleEvent<Document extends CollabDoc> {
  key: string;
  phase: 'opened' | 'closing' | 'disposed';
  session: DocumentSession<Document>;
}

/** Shared factories and writer cadence for one set of documents. */
export interface DocumentSessionsOptions<Document extends CollabDoc> {
  /** Create a fresh empty in-memory document; also used to validate repair frames. */
  createDocument(): Document;
  /** Attach local persistence on the first open that requests recovery. */
  persistence?(key: string, doc: Document, signal: AbortSignal): DocumentPersistence | Promise<DocumentPersistence>;
  timers: DurableWriterTimers;
  clock?: DurableWriterClock;
  onLifecycle?(event: DocumentLifecycleEvent<Document>): void;
  /** Writer error notifications; lifecycle methods reject without repeating the notification. */
  onError?(key: string, error: unknown): void;
  onParentGone?(key: string): void;
}

/** Retained pending changes cannot be saved without writable access. */
export class PendingDocumentChangesError extends Error {
  constructor() {
    super('Pending document changes must be applied and saved before this operation can finish.');
    this.name = 'PendingDocumentChangesError';
  }
}

/** Hydration or local recovery has not completed successfully. Retry open before draining. */
export class DocumentNotReadyError extends Error {
  constructor() {
    super('Document hydration or recovery has not completed successfully.');
    this.name = 'DocumentNotReadyError';
  }
}

/** A stopped writer cannot be reused or certify that pending changes were saved. */
export class DocumentWriterDisposedError extends Error {
  constructor() {
    super('Document writer is disposed. Capture pending changes, then discard and open a fresh session.');
    this.name = 'DocumentWriterDisposedError';
  }
}

type Binding = Pick<OpenDocumentSessionOptions, 'create' | 'writable' | 'canSquash'>;
type CloseAttempt = { promise: Promise<void> };
type Entry<Document extends CollabDoc> = {
  key: string;
  abort: AbortController;
  binding: Binding;
  session?: DocumentSession<Document>;
  writer?: DurableWriter;
  initialized: boolean;
  published: boolean;
  suspended: boolean;
  /** Local/cache edits or pending work retained when writable authority was lost. */
  retainResidual: boolean;
  tail: Promise<void>;
  closing?: CloseAttempt;
  detachLocal?: () => void;
  recoveryRequested: boolean;
  persistencePending?: Promise<DocumentPersistence>;
  persistence?: DocumentPersistence;
  recovered: boolean;
  cleanup?: Promise<void>;
};

function deferredCleanup() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function retiredError(): Error {
  const error = new Error('Document session has been discarded.');
  error.name = 'AbortError';
  return error;
}

/**
 * Own keyed collaborative documents through hydration, recovery, close and reclaim.
 * Each document has one writer and one local-update listener. Failed close or
 * recovery retains its state; discard/dispose explicitly abandon it.
 * Setup is serialized. Authority changes, reclaim and discard fence work immediately;
 * graceful drains use the writer's serialization and cannot finalize a reclaimed entry.
 */
export class DocumentSessions<Document extends CollabDoc> {
  private readonly entries = new Map<string, Entry<Document>>();
  private readonly staged = new Map<string, Uint8Array>();
  private readonly pendingCleanup = new Set<Promise<void>>();
  private disposal?: Promise<void>;

  constructor(private readonly options: DocumentSessionsOptions<Document>) {}

  /**
   * Open or reclaim one document, rebinding future writes to the supplied authority.
   * Concurrent calls share creation. Later recovery requests are honored even when
   * hydration is pending. Omitting recover never detaches a requested adapter.
   * For a valid request, authority changes take effect at invocation; queued setup uses the latest binding.
   * Every failure rejects the returned promise, including synchronous preparation errors.
   * A stopped writer rejects with DocumentWriterDisposedError and needs explicit recreation.
   */
  async open(key: string, options: OpenDocumentSessionOptions): Promise<DocumentSession<Document>> {
    if (this.disposal !== undefined) throw retiredError();
    if (options.recover && this.options.persistence === undefined) {
      throw new TypeError('Document recovery requires a configured persistence adapter.');
    }
    const binding: Binding = { create: options.create, writable: options.writable, canSquash: options.canSquash };
    let entry = this.entries.get(key);
    if (entry !== undefined) this.assertWriterActive(entry);
    if (entry === undefined) {
      entry = {
        key, abort: new AbortController(), binding, initialized: false,
        published: false, suspended: true, retainResidual: false,
        tail: Promise.resolve(), recovered: false, recoveryRequested: false,
      };
      this.entries.set(key, entry);
    }
    const owned = entry;
    const wasWritable = owned.binding.writable;
    owned.binding = binding;
    if (wasWritable && !binding.writable && owned.writer?.capturePendingUpdate() !== undefined) {
      owned.retainResidual = true;
    }
    const previousClose = owned.closing;
    owned.closing = undefined;
    owned.writer?.setCanSquash(options.canSquash);
    if (options.recover && !owned.recovered) {
      owned.recoveryRequested = true;
      owned.suspended = true;
    }
    const opening = owned.tail.then(async () => {
      try {
        this.assertWriterActive(owned);
        if (!owned.initialized) await this.initialize(owned, options.load, options.updates);
        else for (const { data, ...meta } of options.updates ?? []) owned.writer!.applyDurable(data, meta);
        this.assertCurrent(owned);
        if (owned.recoveryRequested && !owned.recovered) {
          // Reclaim before waiting so an older close cannot destroy the recovered document.
          await previousClose?.promise.catch(() => {});
          await this.recover(owned);
        } else {
          owned.suspended = false;
        }
        this.assertCurrent(owned);
        if (!owned.published || previousClose !== undefined) {
          owned.published = true;
          this.emit(owned, 'opened');
        }
        this.assertCurrent(owned);
        return owned.session!;
      } catch (error) {
        // Do not erase valid local state or repair bytes when setup cannot finish.
        if (this.isCurrent(owned)) owned.suspended = true;
        throw error;
      }
    });
    owned.tail = opening.then(() => {}, () => {});
    return opening;
  }

  /** Return a retained handle, including a document whose close failed. */
  get(key: string): DocumentSession<Document> | undefined {
    const entry = this.entries.get(key);
    return entry?.initialized ? entry.session : undefined;
  }

  /** Iterate retained handles once each, including closing documents. */
  *values(): IterableIterator<DocumentSession<Document>> {
    for (const entry of this.entries.values()) if (entry.initialized && entry.session !== undefined) yield entry.session;
  }

  /** Best-effort flush through the currently writable target. */
  async flush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    await entry.tail;
    if (this.isCurrent(entry) && entry.binding.writable && !entry.suspended) await entry.writer?.flush();
  }

  /** Strictly drain one writable document; staged read-only changes remain actionable. */
  async drain(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry !== undefined) await this.drainEntry(entry);
    if (this.staged.has(key)) throw new PendingDocumentChangesError();
  }

  /**
   * Join opening work, drain and dispose. Unconfirmed read-only local/repair changes
   * reject with PendingDocumentChangesError; incomplete recovery rejects with
   * DocumentNotReadyError. A stopped writer with pending work rejects with
   * DocumentWriterDisposedError. Failures before retirement retain the exact handle for
   * retry; adapter cleanup can reject after ownership is already fenced. An
   * intervening open reclaims the handle and fences this close's finalizer.
   */
  close(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve();
    if (entry.closing !== undefined) return entry.closing.promise;
    const attempt: CloseAttempt = { promise: entry.tail.then(async () => {
      if (!this.isCurrent(entry) || entry.closing !== attempt) return;
      this.assertDrainReady(entry);
      this.emit(entry, 'closing');
      if (!this.isCurrent(entry) || entry.closing !== attempt) return;
      await this.drainReady(entry);
      if (entry.closing === attempt && this.isCurrent(entry)) await this.remove(entry, false);
    }) };
    entry.closing = attempt;
    // Retain failures without leaking a rejection when a host closes in the background.
    void attempt.promise.catch(() => {});
    return attempt.promise;
  }

  /** Drain every retained document, finishing successful outstanding closes. */
  async drainAll(): Promise<void> {
    const targets = [...this.entries.values()].map(entry => ({ entry, closing: entry.closing }));
    const results = await Promise.allSettled(targets.map(async ({ entry, closing }) => {
      await this.drainEntry(entry);
      if (this.isCurrent(entry) && closing !== undefined && entry.closing === closing) await this.remove(entry, false);
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
    if (this.staged.size > 0) throw new PendingDocumentChangesError();
  }

  /** Fence immediately and abandon this document; cache deletion is explicit. */
  discard(key: string, options: { clearPersistence?: boolean } = {}): Promise<void> {
    this.staged.delete(key);
    const entry = this.entries.get(key);
    return entry === undefined ? Promise.resolve() : this.remove(entry, options.clearPersistence === true);
  }

  /** Fence all documents synchronously, then await asynchronous adapter cleanup. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    const disposal = deferredCleanup();
    this.disposal = disposal.promise;
    this.staged.clear();
    for (const entry of this.entries.values()) this.remove(entry, false);
    void this.finishCleanup([...this.pendingCleanup]).then(disposal.resolve, disposal.reject);
    return this.disposal;
  }

  /**
   * Copy whole writable/local residuals and staged repairs, including stopped writers.
   * Encoding failures throw without discarding retained edits.
   */
  capturePending(): Array<{ key: string; update: Uint8Array }> {
    const pending = new Map(this.staged);
    for (const entry of this.entries.values()) {
      // A staged frame remains separate until initial hydration applies it successfully.
      if (pending.has(entry.key)) continue;
      const update = this.inspectPending(entry);
      if (update !== undefined) pending.set(entry.key, update);
    }
    return [...pending].map(([key, update]) => ({ key, update: Uint8Array.from(update) }));
  }

  /**
   * Validate and retain a repair before opening its key. Opening/open/retained
   * keys reject staging; invalid bytes leave an earlier staged repair intact.
   */
  stage(key: string, update: Uint8Array): void {
    if (this.disposal !== undefined) throw retiredError();
    if (this.entries.has(key)) throw new TypeError('Stage document changes before opening their key.');
    const copy = Uint8Array.from(update);
    const doc = this.options.createDocument();
    try {
      const result = doc.applyLive(copy);
      if (!result.applied) throw new TypeError(`Invalid staged document update: ${result.reason}`);
    } finally { doc.destroy(); }
    this.staged.set(key, copy);
  }

  /** Whether writable/local or staged state remains beyond known durable storage. */
  hasPending(): boolean {
    if (this.staged.size > 0) return true;
    for (const entry of this.entries.values()) {
      if (this.inspectPending(entry) !== undefined) return true;
    }
    return false;
  }

  private async initialize(
    entry: Entry<Document>,
    load: OpenDocumentSessionOptions['load'],
    initialUpdates: readonly DurableDocumentUpdate[] | undefined,
  ): Promise<void> {
    try {
      const doc = this.options.createDocument();
      const writer = new DurableWriter({
        doc, timers: this.options.timers, clock: this.options.clock, canSquash: entry.binding.canSquash,
        create: request => {
          this.assertWriterActive(entry);
          if (entry.suspended) throw new DocumentNotReadyError();
          if (!entry.binding.writable) throw new PendingDocumentChangesError();
          return entry.binding.create(request);
        },
        onError: error => {
          if (!(error instanceof DocumentNotReadyError) && !(error instanceof PendingDocumentChangesError)) {
            this.options.onError?.(entry.key, error);
          }
        },
        onParentGone: () => this.options.onParentGone?.(entry.key),
      });
      entry.writer = writer;
      entry.session = Object.freeze({
        doc, applyDurable: writer.applyDurable.bind(writer), setTimers: writer.setTimers.bind(writer),
      });
      this.attachLocal(entry);
      const updates = load === undefined ? [] : await this.wait(entry, load(entry.abort.signal));
      this.assertCurrent(entry);
      for (const update of updates ?? []) this.applyUpdate(doc, update);
      for (const update of initialUpdates ?? []) this.applyUpdate(doc, update);
      const staged = this.staged.get(entry.key);
      if (staged !== undefined) {
        const result = doc.applyLive(staged);
        if (!result.applied) throw new Error(`Unable to restore document changes: ${result.reason}`);
        this.staged.delete(entry.key);
        entry.retainResidual = true;
        if (entry.binding.writable) writer.onLocalChange();
      }
      entry.initialized = true;
    } catch (error) {
      await this.remove(entry, false).catch(() => {});
      throw error;
    }
  }

  private async recover(entry: Entry<Document>): Promise<void> {
    const session = entry.session!;
    const writer = entry.writer!;
    this.assertWriterActive(entry);
    entry.suspended = true;
    // Settle an issued write; the dispatch guard prevents another write before recovery.
    await writer.flush();
    this.assertWriterActive(entry);
    entry.persistencePending ??= Promise.resolve().then(() => {
      this.assertCurrent(entry);
      return this.options.persistence!(entry.key, session.doc, entry.abort.signal);
    }).then(persistence => {
      // A late adapter still owns readiness even if its open caller was already aborted.
      void persistence.whenSynced.catch(() => {});
      return persistence;
    });
    try {
      const persistence = await this.wait(entry, entry.persistencePending);
      entry.persistence = persistence;
      this.assertCurrent(entry);
      await this.wait(entry, persistence.whenSynced);
    } catch (error) {
      if (this.isCurrent(entry)) {
        await this.closePersistence(entry, false).catch(() => {});
        entry.persistence = undefined;
        entry.persistencePending = undefined;
      }
      throw error;
    }
    this.assertCurrent(entry);
    entry.suspended = false;
    try {
      if (entry.binding.writable) await writer.drain();
      this.assertCurrent(entry);
      entry.recovered = true;
    } catch (error) {
      entry.suspended = true;
      throw error;
    }
  }

  private applyUpdate(doc: Document, update: DurableDocumentUpdate): void {
    const { data, ...meta } = update;
    const result = doc.applyDurable(data, meta);
    if (!result.applied) throw new Error(`Unable to apply durable document update: ${result.reason}`);
  }

  /** Inspect an eligible residual once and forget confirmed retention markers. */
  private inspectPending(entry: Entry<Document>): Uint8Array | undefined {
    if (!this.isCurrent(entry) || !entry.initialized || (!entry.binding.writable && !entry.retainResidual)) return;
    const pending = entry.writer!.capturePendingUpdate();
    if (pending === undefined) entry.retainResidual = false;
    return pending;
  }

  private attachLocal(entry: Entry<Document>): void {
    entry.detachLocal ??= entry.session!.doc.onLocalUpdate(() => {
      if (!this.isCurrent(entry)) return;
      entry.retainResidual = true;
      if (entry.binding.writable && !entry.suspended) entry.writer!.onLocalChange();
    });
  }

  private async drainEntry(entry: Entry<Document>): Promise<void> {
    await entry.tail;
    await this.drainReady(entry);
  }

  /** Shared barrier after setup; close already joined its captured opening work. */
  private async drainReady(entry: Entry<Document>): Promise<void> {
    if (!this.isCurrent(entry)) return;
    this.assertDrainReady(entry);
    if (entry.binding.writable && !entry.writer!.isDisposed) await entry.writer!.drain();
    if (!this.isCurrent(entry)) return;
    this.assertDrainReady(entry);
    const pending = this.inspectPending(entry);
    if (!entry.binding.writable && pending !== undefined) {
      throw new PendingDocumentChangesError();
    }
  }

  private assertDrainReady(entry: Entry<Document>): void {
    if (entry.writer?.isDisposed) {
      if (entry.suspended || this.inspectPending(entry) !== undefined) throw new DocumentWriterDisposedError();
    }
    if (!entry.initialized || entry.suspended) throw new DocumentNotReadyError();
  }

  private assertWriterActive(entry: Entry<Document>): void {
    this.assertCurrent(entry);
    if (entry.writer?.isDisposed) throw new DocumentWriterDisposedError();
  }

  private isCurrent(entry: Entry<Document>): boolean {
    return this.entries.get(entry.key) === entry;
  }

  private assertCurrent(entry: Entry<Document>): void {
    if (!this.isCurrent(entry)) throw retiredError();
  }

  private emit(entry: Entry<Document>, phase: DocumentLifecycleEvent<Document>['phase']): void {
    if (entry.session !== undefined) notify(() => this.options.onLifecycle?.({ key: entry.key, phase, session: entry.session! }));
  }

  private wait<Value>(entry: Entry<Document>, pending: Promise<Value>): Promise<Value> {
    const signal = entry.abort.signal;
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private closePersistence(entry: Entry<Document>, clear: boolean): Promise<void> {
    const close = (persistence: DocumentPersistence): Promise<void> => this.cleanup(() =>
      clear && persistence.clearData !== undefined ? persistence.clearData() : persistence.destroy());
    if (entry.persistence !== undefined) return close(entry.persistence);
    return entry.persistencePending?.then(close, () => {}) ?? Promise.resolve();
  }

  private remove(entry: Entry<Document>, clear: boolean): Promise<void> {
    if (entry.cleanup !== undefined) return entry.cleanup;
    const cleanup = deferredCleanup();
    entry.cleanup = cleanup.promise;
    this.pendingCleanup.add(cleanup.promise);
    const settled = (): void => { this.pendingCleanup.delete(cleanup.promise); };
    void cleanup.promise.then(settled, settled);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const cleanups: Promise<void>[] = [];
    cleanups.push(this.cleanup(() => entry.abort.abort(retiredError())));
    cleanups.push(this.cleanup(() => entry.detachLocal?.()));
    entry.detachLocal = undefined;
    cleanups.push(this.cleanup(() => entry.writer?.dispose()));
    cleanups.push(this.closePersistence(entry, clear));
    if (entry.session !== undefined) {
      cleanups.push(this.cleanup(() => entry.session!.doc.destroy()));
      if (entry.published) this.emit(entry, 'disposed');
    }
    void this.finishCleanup(cleanups).then(cleanup.resolve, cleanup.reject);
    return cleanup.promise;
  }

  private cleanup(operation: () => void | Promise<void>): Promise<void> {
    try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
  }

  private async finishCleanup(cleanups: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(cleanups);
    const errors = results.flatMap(result => result.status === 'fulfilled' ? []
      : result.reason instanceof AggregateError ? result.reason.errors : [result.reason]);
    if (errors.length > 0) throw new AggregateError(errors, 'Document cleanup failed.');
  }
}
