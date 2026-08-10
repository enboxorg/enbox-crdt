/**
 * The merge-engine seam — the negotiated-format boundary that keeps Enbox
 * documents from being coupled to any single CRDT library.
 *
 * A document is bound to exactly ONE format id for its whole life (SPEC.md §4).
 * Two interface tiers:
 *
 * - {@link MergeEngine} — the WIRE tier: everything sync machinery needs
 *   (apply/diff/state-vector/full-state). This is the seam the SPEC invariants
 *   constrain.
 * - {@link DocEngine} — the DOCUMENT tier: text access, change observation,
 *   undo, and position anchors, so applications interact exclusively with
 *   this library's API and never with the underlying CRDT library. Consumed
 *   by {@link ../collab-doc.js | createCollabDoc}.
 *
 * `@enbox/crdt/yjs1` provides the baseline implementation of both tiers.
 * Future engines (`loro1`, `automerge1`, …) slot in per-document via the
 * envelope's format tag without touching applications.
 *
 * @module
 */

import { decodeEnvelope, EnvelopeError, type EnvelopeErrorCode } from './envelope.js';

/**
 * A CRDT engine for one registered format — the wire tier. Implementations
 * MUST satisfy the SPEC.md §4 invariants: delta application is idempotent,
 * commutative, and order-independent, and a full-state payload is itself a
 * valid delta.
 */
export interface MergeEngine<TDoc = unknown> {
  /** The registered format id this engine produces and consumes (e.g. `'yjs1'`). */
  readonly formatId: string;

  /** Create an empty document. */
  createDoc(): TDoc;

  /** Release a document's resources, when the engine holds any. */
  destroyDoc?(doc: TDoc): void;

  /**
   * Apply a delta payload (NOT enveloped — see {@link applyEnvelope}).
   * Returns `true` iff the document's operation state advanced — i.e. the
   * payload carried operations the document had not seen. Note the engine's
   * notion of "advanced" may be blind to pure deletions (yjs1 is); callers use
   * this for echo suppression, where that blindness is benign.
   * `origin` is threaded into the engine's transaction machinery so change
   * observers can distinguish local edits from remote/live application.
   */
  applyDelta(doc: TDoc, payload: Uint8Array, origin?: unknown): boolean;

  /** Encode the complete document state as one payload (snapshot / squash body). */
  encodeFullState(doc: TDoc): Uint8Array;

  /** Encode the document's state vector (the compact "what I have" summary). */
  encodeStateVector(doc: TDoc): Uint8Array;

  /**
   * Encode the operations the document holds beyond `remoteStateVector`, or
   * `null` when there is nothing NEW to send. Implementations must use a
   * content-aware emptiness test (not payload byte length) so that documents
   * containing deletions do not re-send no-op diffs forever.
   * Throws when `remoteStateVector` is not decodable in this format.
   */
  encodeDiff(doc: TDoc, remoteStateVector: Uint8Array): Uint8Array | null;

  /** Optional: coalesce several delta payloads into one equivalent payload. */
  mergeDeltas?(payloads: Uint8Array[]): Uint8Array;
}

/**
 * One text splice. Edits in a list apply SEQUENTIALLY: each `index` refers to
 * the document as left by the previous edit. Indices are UTF-16 code units
 * (JavaScript string semantics).
 */
export interface TextEdit {
  index: number;
  deleteCount: number;
  insert: string;
}

/** Undo/redo over a document's local edits. Obtained via {@link DocEngine.createUndo}. */
export interface UndoHandle {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Drop both stacks without changing the document. */
  clear(): void;
  destroy(): void;
}

/**
 * The document tier: everything an application needs to work with a
 * collaborative TEXT document without ever importing the underlying CRDT
 * library. Engines expose one primary text body per document (the engine
 * decides its internal container; `yjs1` defaults to `'content'`).
 */
export interface DocEngine<TDoc = unknown> extends MergeEngine<TDoc> {
  /** The document's text body. */
  getText(doc: TDoc): string;

  /** Splice the text body: delete `deleteCount` units at `index`, then insert. */
  spliceText(doc: TDoc, index: number, deleteCount: number, insert: string, origin?: unknown): void;

  /**
   * Observe text changes from ALL sources (local splices, applied deltas).
   * The listener receives sequential {@link TextEdit}s plus the transaction
   * origin that produced them. Returns an unsubscribe.
   */
  observeText(doc: TDoc, listener: (edits: TextEdit[], origin: unknown) => void): () => void;

  /**
   * Observe outbound operation payloads: fired for every transaction with the
   * incremental payload representing it and the transaction origin. Used to
   * broadcast local edits over realtime channels. Returns an unsubscribe.
   */
  onUpdate(doc: TDoc, listener: (payload: Uint8Array, origin: unknown) => void): () => void;

  /** Create an undo manager tracking only transactions with the given origins. */
  createUndo(doc: TDoc, trackedOrigins: unknown[]): UndoHandle;

  /**
   * Encode a stable position anchor at `index` into the text body. Anchors
   * survive concurrent edits (they travel with the character, not the offset)
   * and are safe to ship to peers (cursors, selections). `assoc >= 0`
   * associates with the following character, `assoc < 0` with the preceding.
   */
  anchorAt(doc: TDoc, index: number, assoc?: number): Uint8Array;

  /** Resolve an anchor to a current index, or `null` if it cannot be resolved. */
  indexOfAnchor(doc: TDoc, anchor: Uint8Array): number | null;
}

/** Outcome of {@link applyEnvelope}. Never thrown — callers branch, fail closed. */
export type ApplyEnvelopeResult =
  | { applied: true; advanced: boolean; format: string }
  | {
      applied: false;
      reason: 'not-an-envelope' | 'corrupt-envelope' | 'format-mismatch' | 'invalid-payload';
      format?: string;
      /**
       * On `'corrupt-envelope'`: the underlying decode failure. In particular
       * `'unsupported-version'` means the data is likely from a NEWER client,
       * not damaged — surface "update required", not "corrupt".
       */
      envelopeError?: EnvelopeErrorCode;
    };

/**
 * Decode an enveloped delta and apply it via the engine, without throwing.
 * This is the standard receive path for durable record events and live
 * update/heal frames:
 *
 * - bytes without the envelope magic → `'not-an-envelope'` (legacy data; the
 *   app decides whether a raw-payload migration path applies);
 * - malformed or unsupported-version envelopes → `'corrupt-envelope'` with
 *   `envelopeError` distinguishing the cause;
 * - a format id other than the engine's → `'format-mismatch'` (fail closed —
 *   surface read-only, never guess);
 * - payload the engine rejects → `'invalid-payload'`.
 */
export function applyEnvelope<TDoc>(
  engine: MergeEngine<TDoc>,
  doc: TDoc,
  bytes: Uint8Array,
  origin?: unknown,
): ApplyEnvelopeResult {
  let format: string;
  let payload: Uint8Array;
  try {
    const envelope = decodeEnvelope(bytes);
    format = envelope.format;
    payload = envelope.payload;
  } catch (error) {
    if (error instanceof EnvelopeError) {
      if (error.code === 'not-an-envelope') {
        return { applied: false, reason: 'not-an-envelope' };
      }
      return { applied: false, reason: 'corrupt-envelope', envelopeError: error.code };
    }
    return { applied: false, reason: 'corrupt-envelope' };
  }
  if (format !== engine.formatId) {
    return { applied: false, reason: 'format-mismatch', format };
  }
  try {
    const advanced = engine.applyDelta(doc, payload, origin);
    return { applied: true, advanced, format };
  } catch {
    return { applied: false, reason: 'invalid-payload', format };
  }
}
