/**
 * @enbox/crdt — collaborative document and sync helpers for Enbox applications.
 *
 * Core module: the delta envelope (SPEC.md), the merge-engine seam, and pure
 * flush planning. Subpath exports:
 *
 * - `@enbox/crdt/yjs1` — the baseline `yjs1` document factory
 * - `@enbox/crdt/yjs1/*` — adapters and explicit advanced engine access
 * - `@enbox/crdt/enbox` — DWN write classification + squash timestamp math
 * - `@enbox/crdt/live`  — transport-agnostic state-vector reconciliation
 *
 * @module
 */

export {
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  MAX_FORMAT_ID_LENGTH,
  FORMAT_ID_PATTERN,
  EnvelopeError,
  encodeEnvelope,
  decodeEnvelope,
  tryDecodeEnvelope,
  isEnvelope,
} from './envelope.js';
export type { Envelope, EnvelopeErrorCode } from './envelope.js';

export { applyEnvelope } from './engine.js';
export type { MergeEngine, DocEngine, ApplyEnvelopeResult, TextEdit, UndoHandle } from './engine.js';

export { CollabDoc, createCollabDoc } from './collab-doc.js';
export type {
  CollabDocOptions,
  DurableDeltaMeta,
  FlushAckMeta,
  FlushCommitResult,
  PlanFlushOptions,
  TextChange,
  TextChangeSource,
} from './collab-doc.js';

export {
  DEFAULT_SNAPSHOT_POLICY,
  shouldSnapshot,
  planFlush,
  encodeResidual,
} from './plan.js';
export type { SnapshotPolicy, SnapshotState, FlushState, FlushPlan } from './plan.js';
