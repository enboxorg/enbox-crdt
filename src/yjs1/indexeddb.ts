/** Browser persistence adapter for collaborative documents. */

import type { CollabDoc } from '../collab-doc.js';

import { clearDocument, IndexeddbPersistence } from 'y-indexeddb';

import { unwrapYjs1Document } from './internal.js';

interface VersionChangeDatabase {
  onversionchange: ((event: unknown) => unknown) | null;
}

/** The persistence lifecycle exposed to applications. */
export interface CollabIndexedDbPersistence {
  /**
   * Resolves after stored operations have been merged into the document.
   * Rejects with `AbortError` if persistence retires before synchronization.
   */
  readonly whenSynced: Promise<void>;
  /** Detach persistence while retaining its database. Idempotent. */
  destroy(): Promise<void>;
  /** Detach persistence and delete its database. Idempotent. */
  clearData(): Promise<void>;
}

class Yjs1IndexedDbPersistence implements CollabIndexedDbPersistence {
  public readonly whenSynced: Promise<void>;

  private readonly native: IndexeddbPersistence;
  private readonly nativeDoc: ReturnType<typeof unwrapYjs1Document>;
  private resolveSynced!: () => void;
  private rejectSynced!: (reason: unknown) => void;
  private syncSettled = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private clearPromise: Promise<void> | undefined;

  public constructor(name: string, doc: CollabDoc) {
    this.nativeDoc = unwrapYjs1Document(doc);
    this.native = new IndexeddbPersistence(name, this.nativeDoc);
    this.whenSynced = new Promise<void>((resolve, reject) => {
      this.resolveSynced = resolve;
      this.rejectSynced = reject;
    });
    // Mark the public promise handled even when a caller intentionally tears
    // persistence down without awaiting readiness.
    void this.whenSynced.catch(() => undefined);
    this.native.on('synced', this.handleSynced);
    void this.native._db.then(this.handleDatabaseOpen).catch(this.handleDatabaseError);
    // Replace the provider's fire-and-forget document listener so this facade
    // retains the real asynchronous close promise for later clearData calls.
    this.nativeDoc.off('destroy', this.native.destroy);
    this.nativeDoc.on('destroy', this.handleDocumentDestroy);
  }

  public destroy(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closed = true;
      this.abortSync();
      this.native.off('synced', this.handleSynced);
      this.nativeDoc.off('destroy', this.handleDocumentDestroy);
      this.closePromise = this.native.destroy();
    }
    return this.closePromise;
  }

  public clearData(): Promise<void> {
    this.clearPromise ??= this.destroy()
      .then(() => clearDocument(this.native.name))
      .then(() => undefined);
    return this.clearPromise;
  }

  private readonly handleDocumentDestroy = (): void => {
    if (this.closed) return;
    void this.destroy();
  };

  private readonly handleSynced = (): void => {
    if (this.syncSettled) return;
    this.syncSettled = true;
    this.resolveSynced();
  };

  private readonly handleDatabaseOpen = (database: VersionChangeDatabase): void => {
    if (this.closed) return;
    const close = database.onversionchange;
    database.onversionchange = (event): void => {
      try {
        close?.call(database, event);
      } finally {
        void this.destroy();
      }
    };
  };

  private readonly handleDatabaseError = (error: unknown): void => {
    if (this.syncSettled) return;
    this.syncSettled = true;
    this.rejectSynced(error);
  };

  private abortSync(): void {
    if (this.syncSettled) return;
    this.syncSettled = true;
    const error = new Error('IndexedDB persistence closed before synchronization');
    error.name = 'AbortError';
    this.rejectSynced(error);
  }
}

/** Attach one collaborative document to a named IndexedDB database. */
export function createIndexedDbPersistence(
  name: string,
  doc: CollabDoc,
): CollabIndexedDbPersistence {
  return new Yjs1IndexedDbPersistence(name, doc);
}
