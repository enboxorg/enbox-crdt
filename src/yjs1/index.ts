/**
 * The `yjs1` merge engine — the mandatory baseline format (SPEC.md §3).
 *
 * `yjs1` payloads are Yjs "update v1" encoding as produced by yjs 13.6.x
 * `encodeStateAsUpdate`, the only CRDT wire format with independent
 * cross-language implementations (yrs and y-octo in Rust, ygo in Go, plus
 * Python/Ruby/.NET/Swift bindings over yrs). The peer-dependency range pins
 * `yjs >=13.6.0 <14` deliberately: yjs 14 changes the wire (53-bit client IDs,
 * attribution codecs), so adopting it is a FORMAT decision — a new registry
 * entry — not a dependency bump.
 *
 * This module is the ONLY place in a consuming application's dependency graph
 * where Yjs appears, and it appears here as an implementation detail:
 * applications hold a `CollabDoc` (create one with {@link createYjs1Doc}) and
 * never import `yjs` themselves. Position anchors use the Yjs relative-
 * position v1 encoding, so they interoperate with yrs/y-octo/ygo peers too.
 *
 * @module
 */

import * as Y from 'yjs';

import { bytesEqual } from '../bytes.js';
import { CollabDoc, createCollabDoc, type CollabDocOptions } from '../collab-doc.js';
import type { DocEngine, TextEdit, UndoHandle } from '../engine.js';

/** The registered format id for Yjs update-v1 payloads. */
export const YJS1_FORMAT = 'yjs1';

/** The default text-body container key (matches notesd's protocol). */
export const DEFAULT_TEXT_KEY = 'content';

/** Options for {@link createYjs1Engine}. */
export interface Yjs1EngineOptions {
  /** The Y.Text container key holding the document's text body. */
  textKey?: string;
}

/**
 * Whether a Yjs diff-update carries no NEW operations beyond the base it was
 * diffed against.
 *
 * `Y.encodeStateAsUpdate(doc, sv)` always RE-EMITS the document's full delete
 * set (Yjs cannot diff the delete set against a state vector), so a fully
 * synced document containing deletions produces a non-trivial byte payload
 * that introduces nothing new. Byte-length emptiness tests therefore re-send
 * no-op diffs forever; `Y.parseUpdateMeta(update).to` is non-empty IFF the
 * update carries genuinely new structs, which is the correct,
 * deletion-tolerant test.
 *
 * (A residual consisting ONLY of a deletion the remote lacks is inherently
 * indistinguishable here — that gap heals through the durable log, and
 * re-application is harmlessly idempotent. This matches Yjs's own diff
 * semantics.)
 */
function isEmptyUpdate(update: Uint8Array): boolean {
  return Y.parseUpdateMeta(update).to.size === 0;
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
      return new Y.Doc();
    },

    destroyDoc(doc: Y.Doc): void {
      doc.destroy();
    },

    applyDelta(doc: Y.Doc, payload: Uint8Array, origin?: unknown): boolean {
      const before = Y.encodeStateVector(doc);
      Y.applyUpdate(doc, payload, origin);
      return !bytesEqual(before, Y.encodeStateVector(doc));
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

/** Options for {@link createYjs1Doc}. */
export interface Yjs1DocOptions extends CollabDocOptions, Yjs1EngineOptions {}

/**
 * The one-call entry point for applications: a ready `CollabDoc` over the
 * `yjs1` baseline format. No other Yjs-related import is ever needed.
 */
export function createYjs1Doc(options: Yjs1DocOptions = {}): CollabDoc<Y.Doc> {
  const engine = options.textKey === undefined ? yjs1 : createYjs1Engine({ textKey: options.textKey });
  return createCollabDoc(engine, { snapshotPolicy: options.snapshotPolicy });
}

/**
 * Typed escape hatch: the native `Y.Doc` behind a `yjs1` CollabDoc, for editor
 * bindings (y-codemirror etc.). Throws for documents of any other format.
 */
export function unwrapYDoc(doc: CollabDoc<Y.Doc>): Y.Doc {
  if (doc.format !== YJS1_FORMAT) {
    throw new Error(`unwrapYDoc: document format is '${doc.format}', not '${YJS1_FORMAT}'`);
  }
  return doc.unwrap();
}
