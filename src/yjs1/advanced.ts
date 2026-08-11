/**
 * Advanced native `yjs1` engine access.
 *
 * `yjs1` payloads are Yjs "update v1" encoding as produced by yjs 13.6.x
 * `encodeStateAsUpdate`. The package owns the exact supported runtime version;
 * a future wire-incompatible runtime belongs under a new format id.
 *
 * Most consumers should use `@enbox/crdt/yjs1` and its adapter subpaths. This
 * module exists for custom engines and integrations that explicitly accept
 * native Yjs types.
 *
 * @module
 */

import * as Y from 'yjs';

import { bytesEqual } from '../bytes.js';
import type { CollabDoc } from '../collab-doc.js';
import type { DocEngine, TextEdit, UndoHandle } from '../engine.js';
import { DEFAULT_TEXT_KEY, YJS1_FORMAT } from './constants.js';
import { registerYjs1Document, unwrapYjs1Document } from './internal.js';

export { DEFAULT_TEXT_KEY, YJS1_FORMAT };

/** Options for {@link createYjs1Engine}. */
export interface Yjs1EngineOptions {
  /** The Y.Text container key holding the document's text body. */
  textKey?: string;
}

/**
 * Whether a Yjs diff-update carries no operations at all.
 *
 * A state vector describes structs but NOT which of those structs have been
 * deleted. `Y.encodeStateAsUpdate(doc, sv)` therefore re-emits the document's
 * delete set even when the remote may already have it. We must preserve that
 * conservative payload: dropping it would also drop a deletion the remote
 * genuinely lacks. Callers that own both documents (notably `CollabDoc`) use a
 * full-state equality check to suppress redundant durable writes; live peers
 * harmlessly re-apply the idempotent delete set during reconciliation.
 */
function isEmptyUpdate(update: Uint8Array): boolean {
  const decoded = Y.decodeUpdate(update);
  return decoded.structs.length === 0 && decoded.ds.clients.size === 0;
}

/** Compare optional Yjs pending-update buffers. */
function optionalBytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return bytesEqual(a, b);
}

/** Convert a Y.Text event delta into sequential {@link TextEdit} splices. */
function deltaToEdits(delta: Array<{ insert?: string | object; delete?: number; retain?: number }>): TextEdit[] {
  const edits: TextEdit[] = [];
  let index = 0;
  for (const op of delta) {
    if (typeof op.retain === 'number') {
      index += op.retain;
    } else if (op.insert !== undefined) {
      const text = typeof op.insert === 'string' ? op.insert : '';
      if (text.length > 0) {
        edits.push({ index, deleteCount: 0, insert: text });
        index += text.length;
      }
    } else if (typeof op.delete === 'number' && op.delete > 0) {
      edits.push({ index, deleteCount: op.delete, insert: '' });
    }
  }
  return edits;
}

/**
 * Create a `yjs1` document-tier engine. Engines are stateless and shareable;
 * `textKey` fixes which Y.Text container is the document's text body.
 */
export function createYjs1Engine(options: Yjs1EngineOptions = {}): DocEngine<Y.Doc> {
  const textKey = options.textKey ?? DEFAULT_TEXT_KEY;
  const text = (doc: Y.Doc): Y.Text => doc.getText(textKey);

  return {
    formatId: YJS1_FORMAT,

    createDoc(): Y.Doc {
      const doc = new Y.Doc();
      registerYjs1Document(doc, textKey);
      return doc;
    },

    destroyDoc(doc: Y.Doc): void {
      doc.destroy();
    },

    applyDelta(doc: Y.Doc, payload: Uint8Array, origin?: unknown): boolean {
      const beforePendingDs = doc.store.pendingDs?.slice() ?? null;
      const beforePendingStructs = doc.store.pendingStructs?.update.slice() ?? null;
      let emittedUpdate = false;
      const onUpdate = (): void => {
        emittedUpdate = true;
      };

      doc.on('update', onUpdate);
      try {
        Y.applyUpdate(doc, payload, origin);
      } finally {
        doc.off('update', onUpdate);
      }

      return emittedUpdate ||
        !optionalBytesEqual(beforePendingDs, doc.store.pendingDs) ||
        !optionalBytesEqual(beforePendingStructs, doc.store.pendingStructs?.update ?? null);
    },

    encodeFullState(doc: Y.Doc): Uint8Array {
      return Y.encodeStateAsUpdate(doc);
    },

    encodeStateVector(doc: Y.Doc): Uint8Array {
      return Y.encodeStateVector(doc);
    },

    encodeDiff(doc: Y.Doc, remoteStateVector: Uint8Array): Uint8Array | null {
      const diff = Y.encodeStateAsUpdate(doc, remoteStateVector);
      return isEmptyUpdate(diff) ? null : diff;
    },

    mergeDeltas(payloads: Uint8Array[]): Uint8Array {
      return Y.mergeUpdates(payloads);
    },

    getText(doc: Y.Doc): string {
      return text(doc).toString();
    },

    spliceText(doc: Y.Doc, index: number, deleteCount: number, insert: string, origin?: unknown): void {
      doc.transact(() => {
        const t = text(doc);
        if (deleteCount > 0) t.delete(index, deleteCount);
        if (insert.length > 0) t.insert(index, insert);
      }, origin);
    },

    observeText(doc: Y.Doc, listener: (edits: TextEdit[], origin: unknown) => void): () => void {
      const t = text(doc);
      const handler = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
        const edits = deltaToEdits(event.delta as Array<{ insert?: string | object; delete?: number; retain?: number }>);
        if (edits.length > 0) listener(edits, transaction.origin);
      };
      t.observe(handler);
      return () => t.unobserve(handler);
    },

    onUpdate(doc: Y.Doc, listener: (payload: Uint8Array, origin: unknown) => void): () => void {
      const handler = (payload: Uint8Array, origin: unknown): void => {
        listener(payload, origin);
      };
      doc.on('update', handler);
      return () => doc.off('update', handler);
    },

    createUndo(doc: Y.Doc, trackedOrigins: unknown[]): UndoHandle {
      const manager = new Y.UndoManager(text(doc), {
        trackedOrigins: new Set(trackedOrigins),
      });
      return {
        undo: () => void manager.undo(),
        redo: () => void manager.redo(),
        canUndo: () => manager.undoStack.length > 0,
        canRedo: () => manager.redoStack.length > 0,
        clear: () => manager.clear(),
        destroy: () => manager.destroy(),
      };
    },

    anchorAt(doc: Y.Doc, index: number, assoc = 0): Uint8Array {
      return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text(doc), index, assoc));
    },

    indexOfAnchor(doc: Y.Doc, anchor: Uint8Array): number | null {
      // Instantiate the text root FIRST: resolving against a document that
      // never accessed it would otherwise bind to the untyped placeholder
      // root and fail the identity check below.
      const t = text(doc);
      const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(anchor), doc);
      if (absolute === null || absolute.type !== t) return null;
      return absolute.index;
    },
  };
}

/** The default `yjs1` engine (text body under `'content'`). */
export const yjs1: DocEngine<Y.Doc> = createYjs1Engine();

/**
 * Advanced compatibility escape hatch for integrations not covered by an
 * adapter subpath. Throws for documents of any other format.
 *
 * Prefer the dedicated awareness, CodeMirror, and IndexedDB adapter subpaths,
 * which keep the native runtime private.
 */
export function unwrapYDoc(doc: CollabDoc): Y.Doc {
  return unwrapYjs1Document(doc);
}
