/**
 * Pure flush planning — turns document state into envelope-tagged delta-write
 * decisions while leaving all I/O with the caller.
 *
 * @module
 */

import type { MergeEngine } from './engine.js';
import { encodeEnvelope } from './envelope.js';

/** When the next flush should snapshot (full state) instead of appending. */
export interface SnapshotPolicy {
  /**
   * Snapshot when more than this many DISTINCT delta records exist since the
   * last snapshot. Count distinct record ids, never raw subscription events —
   * overlapping/re-published deltas share content but carry distinct ids and
   * must not inflate the trigger.
   */
  maxDeltasSinceSnapshot: number;
  /**
   * Snapshot when the full encoded state exceeds
   * `max(byteGrowthFactor × lastSnapshotBytes, byteGrowthFloor)`. The floor
   * keeps small, chatty documents compacting by count rather than churning
   * byte-triggered snapshots.
   */
  byteGrowthFactor: number;
  /** See {@link SnapshotPolicy.byteGrowthFactor}. */
  byteGrowthFloor: number;
}

/** Defaults tuned for encrypted delta logs with ~2 MiB record ceilings. */
export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
  maxDeltasSinceSnapshot: 64,
  byteGrowthFactor: 2,
  byteGrowthFloor: 256 * 1024,
};

/** Inputs shared by {@link shouldSnapshot} and {@link planFlush}. */
export interface SnapshotState {
  /** Distinct delta record ids observed since the last snapshot (count or the set itself). */
  distinctDeltasSinceSnapshot: number | Set<string>;
  /** Byte length of the last snapshot's full-state payload; 0 when never snapshotted. */
  lastSnapshotBytes: number;
}

/** Inputs to {@link planFlush}. */
export interface FlushState extends SnapshotState {
  /** The engine state vector at the last acknowledged flush (the incremental base). */
  lastFlushedStateVector: Uint8Array;
  /** Whether this writer is authorized to write snapshots (squash). Defaults to true. */
  canSnapshot?: boolean;
}

/** The write a flush should perform. `delta` is envelope-tagged bytes. */
export type FlushPlan =
  | { kind: 'noop' }
  | { kind: 'incremental'; delta: Uint8Array }
  | { kind: 'snapshot'; delta: Uint8Array };

function distinctCount(input: number | Set<string>): number {
  return typeof input === 'number' ? input : input.size;
}

/**
 * Whether the next authorized flush should snapshot. Pure; both triggers key
 * off deduplicated merged state, never raw event counts.
 */
export function shouldSnapshot<TDoc>(
  engine: MergeEngine<TDoc>,
  doc: TDoc,
  state: SnapshotState,
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
): boolean {
  return snapshotDecision(engine, doc, state, policy).snapshot;
}

/**
 * The {@link shouldSnapshot} decision plus the full state it may have encoded
 * to make it, so {@link planFlush} never encodes the document twice.
 */
function snapshotDecision<TDoc>(
  engine: MergeEngine<TDoc>,
  doc: TDoc,
  state: SnapshotState,
  policy: SnapshotPolicy,
): { snapshot: boolean; fullState?: Uint8Array } {
  if (distinctCount(state.distinctDeltasSinceSnapshot) > policy.maxDeltasSinceSnapshot) {
    return { snapshot: true };
  }
  const fullState = engine.encodeFullState(doc);
  const byteThreshold = Math.max(policy.byteGrowthFactor * state.lastSnapshotBytes, policy.byteGrowthFloor);
  return { snapshot: fullState.byteLength > byteThreshold, fullState };
}

/**
 * Plan the next flush. Pure — the caller performs the write and marks the
 * snapshot flag (e.g. DWN `squash: true`) from the plan kind.
 *
 * - snapshot when authorized and {@link shouldSnapshot} fires — full state;
 * - otherwise the conservative incremental residual beyond
 *   `lastFlushedStateVector`;
 * - `noop` when the format's summary proves the residual empty. For formats
 *   whose state vectors omit operation classes (yjs1 deletions), use
 *   `CollabDoc.planFlush()` so its live/shadow full-state comparison can also
 *   suppress an idempotent conservative residual.
 */
export function planFlush<TDoc>(
  engine: MergeEngine<TDoc>,
  doc: TDoc,
  state: FlushState,
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
): FlushPlan {
  if (state.canSnapshot !== false) {
    const decision = snapshotDecision(engine, doc, state, policy);
    if (decision.snapshot) {
      const fullState = decision.fullState ?? engine.encodeFullState(doc);
      return { kind: 'snapshot', delta: encodeEnvelope(engine.formatId, fullState) };
    }
  }
  const residual = engine.encodeDiff(doc, state.lastFlushedStateVector);
  if (residual === null) return { kind: 'noop' };
  return { kind: 'incremental', delta: encodeEnvelope(engine.formatId, residual) };
}

/**
 * The conservative residual local operations beyond a remote state vector,
 * envelope-tagged, or `null` when the format's summary proves none exist. This
 * is the re-publish invariant's engine-generic core: after a snapshot/squash
 * from another writer, publish what the snapshot may have omitted — never a
 * verbatim retry. `CollabDoc.planRepublish()` additionally compares the owned
 * live/shadow full states to suppress conservative no-op residuals.
 */
export function encodeResidual<TDoc>(
  engine: MergeEngine<TDoc>,
  doc: TDoc,
  remoteStateVector: Uint8Array,
): Uint8Array | null {
  const residual = engine.encodeDiff(doc, remoteStateVector);
  if (residual === null) return null;
  return encodeEnvelope(engine.formatId, residual);
}
