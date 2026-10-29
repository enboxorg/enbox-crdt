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
  destroy(): void | Promise<void>;
  clearData?(): void | Promise<void>;
}

/** One stable document, writer and awareness handle; use the owner for lifetime operations. */
export interface DocumentSession<Document extends CollabDoc, Awareness extends { destroy(): void }> {
  readonly doc: Document;
  readonly writer: DurableWriter;
  readonly awareness: Awareness;
}

/** Native write authority and optional hydration/recovery for one logical document. */
export interface OpenDocumentSessionOptions<Document extends CollabDoc> {
  create: DurableWriterOptions['create'];
  /** Gates native writes; local mutations remain possible and are retained while false. */
  writable: boolean;
  canSquash: boolean;
  /** Queried only when creating the document, with an owner-controlled lifetime signal. */
  load?(signal: AbortSignal): Promise<readonly DurableDocumentUpdate[]>;
  /** Already-loaded records applied on every open, including an authority rebind. */
  updates?: readonly DurableDocumentUpdate[];
  /** Attach once, including to an already-open headless document. */
  persistence?(doc: Document, signal: AbortSignal): DocumentPersistence | Promise<DocumentPersistence>;
}

/**
 * Notifications, not a complete state machine. Closing announces an attempt;
 * its promise may reject while the handle remains retained. Disposed means
 * ownership is fenced; the operation's promise awaits adapter cleanup.
 * Failed initial opens emit none.
 */
export interface DocumentLifecycleEvent<Document extends CollabDoc, Awareness extends { destroy(): void }> {
  key: string;
  phase: 'opened' | 'closing' | 'disposed';
  session: DocumentSession<Document, Awareness>;
}

/** Shared factories and writer cadence for one set of documents. */
export interface DocumentSessionsOptions<Document extends CollabDoc, Awareness extends { destroy(): void }> {
  /** Create a fresh empty in-memory document; also used to validate/combine repair frames. */
  createDocument(): { doc: Document; awareness: Awareness };
  timers: DurableWriterTimers;
  clock?: DurableWriterClock;
  onLifecycle?(event: DocumentLifecycleEvent<Document, Awareness>): void;
  /** Writer error notifications; lifecycle methods reject without repeating the notification. */
  onError?(key: string, error: unknown): void;
  onParentGone?(key: string): void;
}

/** Retained pending changes cannot be saved without writable access. */
export class PendingDocumentChangesError extends Error {
  constructor() {
    super('Pending document changes require writable access before they can be saved.');
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

type Binding = Pick<OpenDocumentSessionOptions<CollabDoc>, 'create' | 'writable' | 'canSquash'>;
type CloseAttempt = { promise: Promise<void> };
type Entry<Document extends CollabDoc, Awareness extends { destroy(): void }> = {
  key: string;
  abort: AbortController;
  binding: Binding;
  session?: DocumentSession<Document, Awareness>;
  initialized: boolean;
  published: boolean;
  retired: boolean;
  suspended: boolean;
  /** Local/cache edits or pending work retained when writable authority was lost. */
  retainResidual: boolean;
  tail: Promise<void>;
  closing?: CloseAttempt;
  detachLocal?: () => void;
  persistenceFactory?: OpenDocumentSessionOptions<Document>['persistence'];
  persistencePending?: Promise<DocumentPersistence>;
  persistence?: DocumentPersistence;
  persistenceCleanup?: Promise<void>;
  recovered: boolean;
  appliedStage?: Uint8Array;
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
export class DocumentSessions<Document extends CollabDoc, Awareness extends { destroy(): void }> {
  private readonly entries = new Map<string, Entry<Document, Awareness>>();
  private readonly staged = new Map<string, Uint8Array>();
  private readonly pendingCleanup = new Set<Promise<void>>();
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(private readonly options: DocumentSessionsOptions<Document, Awareness>) {}

  /**
   * Open or reclaim one document, rebinding future writes to the supplied authority.
   * Concurrent calls share creation. Later recovery requests are honored even when
   * hydration is pending. A missing persistence option never detaches an existing adapter.
   * Authority changes take effect at invocation; queued setup uses the latest binding.
   * Every failure rejects the returned promise, including synchronous preparation errors.
   * A stopped writer rejects with DocumentWriterDisposedError and needs explicit recreation.
   */
  async open(key: string, options: OpenDocumentSessionOptions<Document>): Promise<DocumentSession<Document, Awareness>> {
    if (this.disposed) throw retiredError();
    const binding: Binding = { create: options.create, writable: options.writable, canSquash: options.canSquash };
    let entry = this.entries.get(key);
    if (entry !== undefined) this.assertWriterActive(entry);
    if (entry === undefined) {
      entry = {
        key, abort: new AbortController(), binding, initialized: false,
        published: false, retired: false, suspended: true, retainResidual: false,
        tail: Promise.resolve(), recovered: false,
      };
      this.entries.set(key, entry);
    }
    const owned = entry;
    const wasWritable = owned.binding.writable;
    owned.binding = binding;
    if (wasWritable && !binding.writable && owned.session?.writer.capturePendingUpdate() !== undefined) {
      owned.retainResidual = true;
    }
    const previousClose = owned.closing;
    owned.closing = undefined;
    owned.session?.writer.setCanSquash(options.canSquash);
    if (options.persistence !== undefined && !owned.recovered) {
      owned.persistenceFactory ??= options.persistence;
      owned.suspended = true;
    }
    const opening = owned.tail.then(async () => {
      try {
        this.assertWriterActive(owned);
        if (!owned.initialized) await this.initialize(owned, options.load, options.updates);
        else for (const { data, ...meta } of options.updates ?? []) owned.session!.writer.applyDurable(data, meta);
        this.assertWriterActive(owned);
        // A queued request can replace a failed attachment, never a successful one.
        if (options.persistence !== undefined && !owned.recovered && owned.persistencePending === undefined) {
          owned.persistenceFactory = options.persistence;
        }
        this.applyStaged(owned);
        if (owned.persistenceFactory !== undefined && !owned.recovered) {
          // Reclaim before waiting so an older close cannot destroy the recovered document.
          await previousClose?.promise.catch(() => {});
          await this.recover(owned);
        } else {
          owned.suspended = false;
        }
        this.assertWriterActive(owned);
        if (!owned.published || previousClose !== undefined) {
          owned.published = true;
          this.emit(owned, 'opened');
        }
        this.assertWriterActive(owned);
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
  get(key: string): DocumentSession<Document, Awareness> | undefined {
    const entry = this.entries.get(key);
    return entry?.initialized ? entry.session : undefined;
  }

  /** Iterate retained handles once each, including closing documents. */
  *values(): IterableIterator<DocumentSession<Document, Awareness>> {
    for (const entry of this.entries.values()) if (entry.initialized && entry.session !== undefined) yield entry.session;
  }

  /** Best-effort flush through the currently writable target. */
  async flush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    await entry.tail;
    if (this.isCurrent(entry) && entry.binding.writable && !entry.suspended) await entry.session?.writer.flush();
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
    const attempt: CloseAttempt = { promise: Promise.resolve() };
    entry.closing = attempt;
    const opening = entry.tail;
    attempt.promise = opening.then(async () => {
      if (!this.isCurrent(entry) || entry.closing !== attempt) return;
      this.assertDrainReady(entry);
      this.emit(entry, 'closing');
      if (!this.isCurrent(entry) || entry.closing !== attempt) return;
      await this.drainReady(entry);
      if (entry.closing === attempt && this.isCurrent(entry)) await this.remove(entry, false);
    });
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
    for (const entry of this.entries.values()) this.clearConfirmedStage(entry);
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
    this.disposed = true;
    this.staged.clear();
    for (const entry of this.entries.values()) this.remove(entry, false);
    void this.finishCleanup([...this.pendingCleanup]).then(disposal.resolve, disposal.reject);
    return this.disposal;
  }

  /**
   * Copy whole writable/local residuals and staged repairs, including stopped writers.
   * Encoding/combination failures throw without discarding retained edits.
   */
  capturePending(): Array<{ key: string; update: Uint8Array }> {
    for (const entry of this.entries.values()) this.clearConfirmedStage(entry);
    const pending = new Map(this.staged);
    for (const entry of this.entries.values()) {
      if (entry.binding.writable || entry.retainResidual || pending.has(entry.key)) {
        const session = entry.session;
        const update = session?.writer.isDisposed && pending.has(entry.key)
          ? session.doc.encodeFullState()
          : session?.writer.capturePendingUpdate();
        if (update !== undefined) {
          const staged = pending.get(entry.key);
          pending.set(entry.key, staged !== undefined && staged !== entry.appliedStage
            ? this.withTemporaryDocument(doc => {
              this.applyUpdate(doc, { data: staged });
              this.applyUpdate(doc, { data: update });
              return doc.encodeFullState();
            }) : update);
        }
      }
    }
    return [...pending].map(([key, update]) => ({ key, update: Uint8Array.from(update) }));
  }

  /**
   * Validate and copy a repair frame before retaining it. Validation uses a
   * temporary document from createDocument; invalid input leaves existing state intact.
   */
  stage(key: string, update: Uint8Array): void {
    if (this.disposed) throw retiredError();
    const copy = Uint8Array.from(update);
    this.withTemporaryDocument(doc => {
      const result = doc.applyLive(copy);
      if (!result.applied) throw new TypeError(`Invalid staged document update: ${result.reason}`);
    });
    this.staged.set(key, copy);
  }

  /** Whether writable/local or staged state remains beyond known durable storage. */
  hasPending(): boolean {
    for (const entry of this.entries.values()) this.clearConfirmedStage(entry);
    if (this.staged.size > 0) return true;
    for (const entry of this.entries.values()) {
      if ((entry.binding.writable || entry.retainResidual) && entry.session?.writer.capturePendingUpdate() !== undefined) return true;
    }
    return false;
  }

  private async initialize(
    entry: Entry<Document, Awareness>,
    load: OpenDocumentSessionOptions<Document>['load'],
    initialUpdates: readonly DurableDocumentUpdate[] | undefined,
  ): Promise<void> {
    try {
      const { doc, awareness } = this.options.createDocument();
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
      entry.session = Object.freeze({ doc, writer, awareness });
      this.attachLocal(entry);
      const updates = load === undefined ? [] : await this.wait(entry, load(entry.abort.signal));
      this.assertCurrent(entry);
      for (const update of updates ?? []) this.applyUpdate(doc, update);
      for (const update of initialUpdates ?? []) this.applyUpdate(doc, update);
      entry.initialized = true;
    } catch (error) {
      await this.remove(entry, false).catch(() => {});
      throw error;
    }
  }

  private async recover(entry: Entry<Document, Awareness>): Promise<void> {
    const session = entry.session!;
    this.assertWriterActive(entry);
    entry.suspended = true;
    // Settle an issued write; the dispatch guard prevents another write before recovery.
    await session.writer.flush();
    this.assertWriterActive(entry);
    entry.persistencePending ??= Promise.resolve().then(() => {
      this.assertWriterActive(entry);
      return entry.persistenceFactory!(session.doc, entry.abort.signal);
    }).then(persistence => {
      // A late adapter still owns readiness even if its open caller was already aborted.
      void persistence.whenSynced.catch(() => {});
      return persistence;
    });
    try {
      const persistence = await this.wait(entry, entry.persistencePending);
      entry.persistence = persistence;
      this.assertWriterActive(entry);
      await this.wait(entry, persistence.whenSynced);
    } catch (error) {
      if (this.isCurrent(entry)) {
        await this.closePersistence(entry, false).catch(() => {});
        entry.persistence = undefined;
        entry.persistencePending = undefined;
        entry.persistenceCleanup = undefined;
      }
      throw error;
    }
    this.assertWriterActive(entry);
    entry.suspended = false;
    try {
      if (entry.binding.writable) await session.writer.drain();
      this.assertWriterActive(entry);
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

  private applyStaged(entry: Entry<Document, Awareness>): void {
    const update = this.staged.get(entry.key);
    if (update === undefined) return;
    const result = entry.session!.doc.applyLive(update);
    if (!result.applied) throw new Error(`Unable to restore document changes: ${result.reason}`);
    entry.appliedStage = update;
    entry.retainResidual = true;
    if (entry.binding.writable) {
      this.staged.delete(entry.key);
      entry.appliedStage = undefined;
      entry.session!.writer.onLocalChange();
    }
  }

  private clearConfirmedStage(entry: Entry<Document, Awareness>): void {
    if (!entry.retainResidual && entry.appliedStage === undefined) return;
    if (this.isCurrent(entry) && entry.session !== undefined
      && entry.session.writer.capturePendingUpdate() === undefined) {
      entry.retainResidual = false;
      if (entry.appliedStage !== undefined && entry.appliedStage === this.staged.get(entry.key)) {
        this.staged.delete(entry.key);
        entry.appliedStage = undefined;
      }
    }
  }

  private attachLocal(entry: Entry<Document, Awareness>): void {
    entry.detachLocal ??= entry.session!.doc.onLocalUpdate(() => {
      if (!this.isCurrent(entry)) return;
      entry.retainResidual = true;
      if (entry.binding.writable && !entry.suspended) entry.session!.writer.onLocalChange();
    });
  }

  private async drainEntry(entry: Entry<Document, Awareness>): Promise<void> {
    await entry.tail;
    await this.drainReady(entry);
  }

  /** Shared barrier after setup; close already joined its captured opening work. */
  private async drainReady(entry: Entry<Document, Awareness>): Promise<void> {
    if (!this.isCurrent(entry)) return;
    this.assertDrainReady(entry);
    if (entry.binding.writable && !entry.session!.writer.isDisposed) await entry.session!.writer.drain();
    if (!this.isCurrent(entry)) return;
    this.assertDrainReady(entry);
    if (this.staged.has(entry.key) || (!entry.binding.writable && entry.retainResidual)) {
      throw new PendingDocumentChangesError();
    }
  }

  private assertDrainReady(entry: Entry<Document, Awareness>): void {
    this.clearConfirmedStage(entry);
    if (entry.session?.writer.isDisposed && (entry.suspended || this.staged.has(entry.key)
      || ((entry.binding.writable || entry.retainResidual) && entry.session.writer.capturePendingUpdate() !== undefined))) {
      throw new DocumentWriterDisposedError();
    }
    if (!entry.initialized || entry.suspended) throw new DocumentNotReadyError();
  }

  private assertWriterActive(entry: Entry<Document, Awareness>): void {
    this.assertCurrent(entry);
    if (entry.session?.writer.isDisposed) throw new DocumentWriterDisposedError();
  }

  /** Validate or combine repairs without mutating the retained live document. */
  private withTemporaryDocument<Value>(operation: (doc: Document) => Value): Value {
    const { doc, awareness } = this.options.createDocument();
    try { return operation(doc); } finally {
      try { awareness.destroy(); } finally { doc.destroy(); }
    }
  }

  private isCurrent(entry: Entry<Document, Awareness>): boolean {
    return !entry.retired && this.entries.get(entry.key) === entry;
  }

  private assertCurrent(entry: Entry<Document, Awareness>): void {
    if (!this.isCurrent(entry)) throw retiredError();
  }

  private emit(entry: Entry<Document, Awareness>, phase: DocumentLifecycleEvent<Document, Awareness>['phase']): void {
    if (entry.session !== undefined) notify(() => this.options.onLifecycle?.({ key: entry.key, phase, session: entry.session! }));
  }

  private wait<Value>(entry: Entry<Document, Awareness>, pending: Promise<Value>): Promise<Value> {
    const signal = entry.abort.signal;
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private closePersistence(entry: Entry<Document, Awareness>, clear: boolean): Promise<void> {
    if (entry.persistenceCleanup !== undefined) return entry.persistenceCleanup;
    const close = (persistence: DocumentPersistence): Promise<void> => this.cleanup(() =>
      clear && persistence.clearData !== undefined ? persistence.clearData() : persistence.destroy());
    if (entry.persistence !== undefined) entry.persistenceCleanup = close(entry.persistence);
    else if (entry.persistencePending !== undefined) entry.persistenceCleanup = entry.persistencePending.then(close, () => {});
    return entry.persistenceCleanup ?? Promise.resolve();
  }

  private remove(entry: Entry<Document, Awareness>, clear: boolean): Promise<void> {
    if (entry.cleanup !== undefined) return entry.cleanup;
    const cleanup = deferredCleanup();
    entry.cleanup = cleanup.promise;
    this.pendingCleanup.add(cleanup.promise);
    const settled = (): void => { this.pendingCleanup.delete(cleanup.promise); };
    void cleanup.promise.then(settled, settled);
    entry.retired = true;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const cleanups: Promise<void>[] = [];
    cleanups.push(this.cleanup(() => entry.abort.abort(retiredError())));
    cleanups.push(this.cleanup(() => entry.detachLocal?.()));
    entry.detachLocal = undefined;
    cleanups.push(this.cleanup(() => entry.session?.writer.dispose()));
    cleanups.push(this.closePersistence(entry, clear));
    if (entry.session !== undefined) {
      cleanups.push(this.cleanup(() => entry.session!.awareness.destroy()));
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
