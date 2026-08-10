/**
 * The merge-engine seam — the negotiated-format boundary that keeps Enbox
 * documents from being coupled to any single CRDT library.
 *
 * A document is bound to exactly ONE format id for its whole life (SPEC.md §4).
 * Sync machinery in this package (planning, live reconciliation) is written
 * against this interface; `@enbox/crdt/yjs1` provides the baseline engine.
 * Future engines (`loro1`, `automerge1`, …) slot in per-document via the
 * envelope's format tag without touching the machinery.
 *
 * @module
 */

import { decodeEnvelope, EnvelopeError } from './envelope.js';

/**
 * A CRDT engine for one registered format. Implementations MUST satisfy the
 * SPEC.md §4 invariants: delta application is idempotent, commutative, and
 * order-independent, and a full-state payload is itself a valid delta.
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
   * `origin` is threaded into the engine's transaction machinery so app-level
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

/** Outcome of {@link applyEnvelope}. Never thrown — callers branch, fail closed. */
export type ApplyEnvelopeResult =
  | { applied: true; advanced: boolean; format: string }
  | { applied: false; reason: 'not-an-envelope' | 'corrupt-envelope' | 'format-mismatch' | 'invalid-payload'; format?: string };

/**
 * Decode an enveloped delta and apply it via the engine, without throwing.
 * This is the standard receive path for durable record events and live
 * update/heal frames:
 *
 * - bytes without the envelope magic → `'not-an-envelope'` (legacy data; the
 *   app decides whether a raw-payload migration path applies);
 * - malformed or unsupported-version envelopes → `'corrupt-envelope'`;
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
    if (error instanceof EnvelopeError && error.code === 'not-an-envelope') {
      return { applied: false, reason: 'not-an-envelope' };
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
