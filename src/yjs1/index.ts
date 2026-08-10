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
 * This module never wraps or hides `Y.Doc`: apps keep binding editors,
 * undo managers, and persistence to Yjs directly. The engine only fixes the
 * wire semantics the sync machinery relies on.
 *
 * @module
 */

import * as Y from 'yjs';

import { bytesEqual } from '../bytes.js';
import type { MergeEngine } from '../engine.js';

/** The registered format id for Yjs update-v1 payloads. */
export const YJS1_FORMAT = 'yjs1';

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

/** The `yjs1` engine. Stateless — safe to share across documents. */
export const yjs1: MergeEngine<Y.Doc> = {
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
};
