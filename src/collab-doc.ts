/**
 * CollabDoc — the application-facing document handle. Apps interact with a
 * collaborative document ENTIRELY through this API: text access, change
 * observation, undo, position anchors, durable/live delta application, flush
 * planning, and realtime reconciliation. The underlying CRDT library never
 * appears in ordinary application code; {@link CollabDoc.unwrap} remains only
 * as an advanced native compatibility escape hatch.
 *
 * Internally a CollabDoc owns two engine documents:
 *
 * - the LIVE document — local edits, applied durable deltas, and realtime
 *   frames; the state the UI renders;
 * - the DURABLE SHADOW — only operations known to have reached durable
 *   storage (acknowledged flushes + subscribed durable deltas).
 *
 * The residual "live beyond shadow" answers the critical question *what might
 * durable storage still lack?* — it drives {@link CollabDoc.planFlush},
 * {@link CollabDoc.planRepublish}, and {@link CollabDoc.hasUnflushedChanges}.
 * A snapshot (squash) REPLACES the shadow, because storage pruned the older
 * sibling set: anything the snapshot omitted automatically reappears in the
 * residual and is re-published — the squash-race invariant.
 *
 * @module
 */

import type { ApplyEnvelopeResult, DocEngine, TextEdit } from './engine.js';
import { bytesEqual } from './bytes.js';
import { applyEnvelope } from './engine.js';
import { addMicrosecondTick, computeRepublish, type RepublishOptions, type RepublishResult } from './enbox/index.js';
import { decodeEnvelope, encodeEnvelope } from './envelope.js';
import { wireLiveSync, type LiveSyncOptions, type SyncChannel } from './live/index.js';
import { DEFAULT_SNAPSHOT_POLICY, planFlush, type FlushPlan, type SnapshotPolicy } from './plan.js';

/** Where a text change came from. */
export type TextChangeSource = 'local' | 'durable' | 'live';

/** A batch of sequential text edits plus their provenance. */
export interface TextChange {
  edits: TextEdit[];
  source: TextChangeSource;
}

/** Metadata accompanying a durable delta application. */
export interface DurableDeltaMeta {
  /** The delta's record id — used to count distinct deltas toward compaction. */
  recordId?: string;
  /** Whether this record is a snapshot/squash (from the signed descriptor). */
  snapshot?: boolean;
  /**
   * The record's message timestamp (DWN microsecond ISO-8601). When provided,
   * deltas stamped at or below the last seen snapshot are applied to the live
   * document only — storage pruned them, so treating them as durable would
   * silently drop the squash-race residual.
   */
  messageTimestamp?: string;
}

/** Metadata accompanying a successful flush acknowledgement. */
export interface FlushAckMeta {
  recordId?: string;
  /**
   * The acknowledged write's message timestamp. Supply it for every write so
   * an acknowledgement that lost a race with a newer snapshot cannot advance
   * the durable shadow with a record the snapshot already purged.
   */
  messageTimestamp?: string;
}

/** Outcome of committing an acknowledged flush or re-publish write. */
export type FlushCommitResult =
  | { committed: true }
  | { committed: false; reason: 'noop' }
  | { committed: false; reason: 'superseded'; squashFloorTimestamp: string };

/** Options for {@link createCollabDoc}. */
export interface CollabDocOptions {
  snapshotPolicy?: SnapshotPolicy;
}

/** Options for {@link CollabDoc.planFlush}. */
export interface PlanFlushOptions {
  /** Whether this writer may issue snapshots (squash authority). Default true. */
  canSnapshot?: boolean;
}

let syntheticIdCounter = 0;

/** Later of two canonical DWN timestamps, ignoring absent values. */
function latestTimestamp(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a >= b ? a : b;
}

/**
 * The application-facing collaborative document. Create via
 * {@link createCollabDoc} (or an engine convenience like `createYjs1Doc`).
 *
 * Threading model: single writer loop per document — serialize
 * {@link planFlush}/{@link commitFlush} pairs (do not interleave concurrent
 * flushes of the same document). `DurableWriter` from `@enbox/crdt/enbox`
 * owns that scheduling and commit sequence for standard Enbox persistence.
 */
export class CollabDoc<TDoc = unknown> {
  private readonly engine: DocEngine<TDoc>;
  private readonly policy: SnapshotPolicy;
  private readonly live: TDoc;
  private shadow: TDoc;

  /** Per-instance origin markers — engine transactions carry these. */
  private readonly LOCAL: symbol = Symbol('enbox-crdt:local');
  private readonly DURABLE: symbol = Symbol('enbox-crdt:durable');
  private readonly LIVE: symbol = Symbol('enbox-crdt:live');

  private readonly distinctDeltaIds = new Set<string>();
  private lastSnapshotBytes = 0;
  private lastSnapshotTimestamp: string | undefined;
  /** A reported squash whose contents have not been observed; compaction cannot cover its unknown operations. */
  private unseenSnapshotTimestamp: string | undefined;

  private undoHandle: ReturnType<DocEngine<TDoc>['createUndo']> | undefined;
  private readonly teardowns = new Set<() => void>();
  private destroyed = false;

  constructor(engine: DocEngine<TDoc>, options: CollabDocOptions = {}) {
    this.engine = engine;
    this.policy = options.snapshotPolicy ?? DEFAULT_SNAPSHOT_POLICY;
    this.live = engine.createDoc();
    this.shadow = engine.createDoc();
  }

  /** The document's registered format id (e.g. `'yjs1'`). */
  get format(): string {
    return this.engine.formatId;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('CollabDoc has been destroyed');
  }

  /** Register a teardown shared by explicit unsubscribe and document destroy. */
  private registerTeardown(teardown: () => void): () => void {
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      this.teardowns.delete(release);
      teardown();
    };
    this.teardowns.add(release);
    return release;
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  /** The current text body. */
  getText(): string {
    this.assertAlive();
    return this.engine.getText(this.live);
  }

  /** Insert `text` at `index` as a local edit. */
  insertText(index: number, text: string): void {
    this.assertAlive();
    this.engine.spliceText(this.live, index, 0, text, this.LOCAL);
  }

  /** Delete `length` units at `index` as a local edit. */
  deleteText(index: number, length: number): void {
    this.assertAlive();
    this.engine.spliceText(this.live, index, length, '', this.LOCAL);
  }

  /** Replace `length` units at `index` with `text` as one local edit. */
  replaceText(index: number, length: number, text: string): void {
    this.assertAlive();
    this.engine.spliceText(this.live, index, length, text, this.LOCAL);
  }

  /**
   * Observe text changes from all sources. Edits apply sequentially; indices
   * are UTF-16 code units. `source` is `'durable'`/`'live'` for changes this
   * document applied from peers, `'local'` for everything else (including
   * editor-binding writes through {@link unwrap}).
   */
  onTextChange(listener: (change: TextChange) => void): () => void {
    this.assertAlive();
    const off = this.engine.observeText(this.live, (edits, origin) => {
      listener({ edits, source: this.classify(origin) });
    });
    return this.registerTeardown(off);
  }

  private classify(origin: unknown): TextChangeSource {
    if (origin === this.DURABLE) return 'durable';
    if (origin === this.LIVE) return 'live';
    return 'local';
  }

  // -------------------------------------------------------------------------
  // Anchors (stable positions for cursors/selections)
  // -------------------------------------------------------------------------

  /**
   * Encode a stable anchor at `index`. Anchors survive concurrent edits and
   * are safe to send to peers. `assoc >= 0` sticks to the following character,
   * `assoc < 0` to the preceding one.
   */
  anchorAt(index: number, assoc = 0): Uint8Array {
    this.assertAlive();
    return this.engine.anchorAt(this.live, index, assoc);
  }

  /** Resolve an anchor to its current index, or `null` when unresolvable. */
  indexOfAnchor(anchor: Uint8Array): number | null {
    this.assertAlive();
    return this.engine.indexOfAnchor(this.live, anchor);
  }

  // -------------------------------------------------------------------------
  // Undo (local edits made through this API)
  // -------------------------------------------------------------------------

  private undo_(): ReturnType<DocEngine<TDoc>['createUndo']> {
    this.undoHandle ??= this.engine.createUndo(this.live, [this.LOCAL]);
    return this.undoHandle;
  }

  /** Undo the last local edit batch. Peer changes are never undone. */
  undo(): void {
    this.assertAlive();
    this.undo_().undo();
  }

  /** Redo the last undone local edit batch. */
  redo(): void {
    this.assertAlive();
    this.undo_().redo();
  }

  canUndo(): boolean {
    this.assertAlive();
    return this.undo_().canUndo();
  }

  canRedo(): boolean {
    this.assertAlive();
    return this.undo_().canRedo();
  }

  // -------------------------------------------------------------------------
  // Inbound deltas
  // -------------------------------------------------------------------------

  /**
   * Apply a durable delta record (hydration query results and subscription
   * events alike; order-independent). Advances the live document AND the
   * durable shadow — except deltas stamped at or below the last snapshot's
   * timestamp, which advance the live document only (storage pruned them; see
   * {@link DurableDeltaMeta.messageTimestamp}).
   *
   * A snapshot record REPLACES the shadow and resets compaction counters; any
   * local or previously-acknowledged operation the snapshot omitted is then
   * present in {@link planFlush}'s residual and gets re-published.
   */
  applyDurable(bytes: Uint8Array, meta: DurableDeltaMeta = {}): ApplyEnvelopeResult {
    this.assertAlive();
    const outcome = applyEnvelope(this.engine, this.live, bytes, this.DURABLE);
    if (!outcome.applied) return outcome;
    const { payload } = decodeEnvelope(bytes); // header re-parse only; payload is a view

    if (meta.snapshot === true) {
      const superseded =
        (this.unseenSnapshotTimestamp !== undefined && meta.messageTimestamp === undefined) ||
        (this.lastSnapshotTimestamp !== undefined &&
          meta.messageTimestamp !== undefined &&
          meta.messageTimestamp < this.lastSnapshotTimestamp);
      if (!superseded) {
        this.replaceShadow(payload);
        this.advanceSnapshotFloor(meta.messageTimestamp);
        if (this.unseenSnapshotTimestamp !== undefined && meta.messageTimestamp !== undefined &&
          meta.messageTimestamp >= this.unseenSnapshotTimestamp) this.unseenSnapshotTimestamp = undefined;
      }
      return outcome;
    }

    const staleBelowSnapshot =
      (this.unseenSnapshotTimestamp !== undefined && meta.messageTimestamp === undefined) ||
      (this.lastSnapshotTimestamp !== undefined &&
        meta.messageTimestamp !== undefined &&
        meta.messageTimestamp <= this.lastSnapshotTimestamp);
    if (!staleBelowSnapshot) {
      this.engine.applyDelta(this.shadow, payload);
      this.distinctDeltaIds.add(meta.recordId ?? `synthetic:${++syntheticIdCounter}`);
    }
    return outcome;
  }

  /**
   * Apply a realtime frame (update or heal). Advances the live document only —
   * realtime is never the durability owner; the durable log heals drops. Note
   * that live-received peer operations may consequently ride this writer's
   * next flush: redundant but idempotent, and it heals a peer whose own flush
   * was dropped.
   */
  applyLive(bytes: Uint8Array): ApplyEnvelopeResult {
    this.assertAlive();
    return applyEnvelope(this.engine, this.live, bytes, this.LIVE);
  }

  /**
   * Outbound realtime feed: fires an envelope-tagged incremental payload for
   * every transaction that did NOT come from {@link applyDurable}/
   * {@link applyLive} — i.e. local edits (API or editor binding) and undo/redo.
   * Broadcast these over the live channel; coalescing is the transport's job.
   */
  onLocalUpdate(listener: (frame: Uint8Array) => void): () => void {
    this.assertAlive();
    const off = this.engine.onUpdate(this.live, (payload, origin) => {
      if (origin === this.DURABLE || origin === this.LIVE) return;
      listener(encodeEnvelope(this.engine.formatId, payload));
    });
    return this.registerTeardown(off);
  }

  // -------------------------------------------------------------------------
  // Flush planning (durable writes; I/O stays with the caller)
  // -------------------------------------------------------------------------

  /**
   * Plan the next durable write: `noop`, an incremental residual, or (when
   * authorized and the compaction policy fires) a full-state snapshot to be
   * written with the storage squash flag. Write `plan.delta` as the record
   * value, then call {@link commitFlush} on acknowledgement.
   */
  planFlush(options: PlanFlushOptions = {}): FlushPlan {
    this.assertAlive();
    const plan = planFlush(
      this.engine,
      this.live,
      {
        lastFlushedStateVector: this.engine.encodeStateVector(this.shadow),
        distinctDeltasSinceSnapshot: this.distinctDeltaIds,
        lastSnapshotBytes: this.lastSnapshotBytes,
        canSnapshot: this.unseenSnapshotTimestamp === undefined ? options.canSnapshot : false,
      },
      this.policy,
    );
    // A yjs1 state vector cannot express delete-set knowledge, so its generic
    // diff is deliberately conservative. Here we own both documents and can
    // suppress an incremental write once their canonical full states agree.
    return plan.kind === 'incremental' && this.isDurablyConverged()
      ? { kind: 'noop' }
      : plan;
  }

  /**
   * Record a successful write of `plan`. An acknowledgement at or below a
   * newer snapshot floor is rejected as superseded, because that record is no
   * longer part of durable storage and must remain in the re-publish residual.
   */
  commitFlush(plan: FlushPlan, meta: FlushAckMeta = {}): FlushCommitResult {
    this.assertAlive();
    if (plan.kind === 'noop') return { committed: false, reason: 'noop' };
    const superseded = this.supersededCommit(meta.messageTimestamp);
    if (superseded !== undefined) return superseded;

    const { payload } = decodeEnvelope(plan.delta);
    if (plan.kind === 'snapshot') {
      this.replaceShadow(payload);
      this.advanceSnapshotFloor(meta.messageTimestamp);
      return { committed: true };
    }
    this.engine.applyDelta(this.shadow, payload);
    this.distinctDeltaIds.add(meta.recordId ?? `synthetic:${++syntheticIdCounter}`);
    return { committed: true };
  }

  /**
   * Record a successful fresh write returned by {@link planRepublish}. This is
   * the re-publish counterpart to {@link commitFlush}; callers should not need
   * to manufacture a synthetic incremental {@link FlushPlan} merely to advance
   * the durable shadow.
   */
  commitRepublish(republish: RepublishResult, meta: FlushAckMeta = {}): FlushCommitResult {
    return this.commitFlush(
      { kind: 'incremental', delta: republish.delta },
      { ...meta, messageTimestamp: meta.messageTimestamp ?? republish.messageTimestamp },
    );
  }

  /**
   * The re-publish invariant: the residual this document holds beyond durable
   * storage, as a fresh envelope-tagged delta — or `null` when converged. Call
   * after a write rejection or after applying a foreign snapshot. The newest
   * observed or acknowledged snapshot is used as the timestamp floor. Pass an
   * explicit `afterSquashTs` only when a rejection reports a newer floor, and
   * stamp the returned `messageTimestamp` on the fresh record. An unseen newer
   * floor invalidates the old durable shadow: recovery includes all known
   * dependencies, and compaction waits until that snapshot's contents arrive.
   */
  planRepublish(options: RepublishOptions = {}): RepublishResult | null {
    this.assertAlive();
    if (options.afterSquashTs !== undefined &&
      (this.lastSnapshotTimestamp === undefined || options.afterSquashTs > this.lastSnapshotTimestamp)) {
      addMicrosecondTick(options.afterSquashTs);
      this.replaceShadow();
      this.lastSnapshotTimestamp = options.afterSquashTs;
      this.unseenSnapshotTimestamp = options.afterSquashTs;
    }
    if (this.isDurablyConverged()) return null;
    return computeRepublish(this.engine, this.live, this.engine.encodeStateVector(this.shadow), {
      ...options,
      afterSquashTs: latestTimestamp(options.afterSquashTs, this.lastSnapshotTimestamp),
    });
  }

  /** Whether durable storage might still lack local operations. */
  hasUnflushedChanges(): boolean {
    this.assertAlive();
    return !this.isDurablyConverged();
  }

  private isDurablyConverged(): boolean {
    return bytesEqual(this.engine.encodeFullState(this.live), this.engine.encodeFullState(this.shadow));
  }

  private advanceSnapshotFloor(messageTimestamp: string | undefined): void {
    if (
      messageTimestamp !== undefined &&
      (this.lastSnapshotTimestamp === undefined || messageTimestamp > this.lastSnapshotTimestamp)
    ) {
      this.lastSnapshotTimestamp = messageTimestamp;
    }
  }

  private supersededCommit(messageTimestamp: string | undefined): FlushCommitResult | undefined {
    if (
      this.lastSnapshotTimestamp === undefined ||
      (messageTimestamp === undefined
        ? this.unseenSnapshotTimestamp === undefined
        : messageTimestamp > this.lastSnapshotTimestamp)
    ) {
      return undefined;
    }
    return {
      committed: false,
      reason: 'superseded',
      squashFloorTimestamp: this.lastSnapshotTimestamp,
    };
  }

  private replaceShadow(snapshotPayload?: Uint8Array): void {
    this.engine.destroyDoc?.(this.shadow);
    this.shadow = this.engine.createDoc();
    if (snapshotPayload !== undefined) this.engine.applyDelta(this.shadow, snapshotPayload);
    this.distinctDeltaIds.clear();
    this.lastSnapshotBytes = snapshotPayload?.byteLength ?? 0;
  }

  // -------------------------------------------------------------------------
  // Realtime reconciliation
  // -------------------------------------------------------------------------

  /**
   * Wire state-vector reconciliation onto a channel: probes on connect and on
   * an interval; answers peers with a conservative diff when needed. Feed
   * inbound update/heal frames to {@link applyLive} and outbound
   * {@link onLocalUpdate} frames to the channel — that completes the loop.
   * Returns a teardown (also run by {@link destroy}).
   */
  connectLiveSync(channel: SyncChannel, options?: LiveSyncOptions): () => void {
    this.assertAlive();
    const off = wireLiveSync(
      this.engine,
      channel,
      () => (this.destroyed ? undefined : this.live),
      () => !this.destroyed,
      options,
    );
    return this.registerTeardown(off);
  }

  // -------------------------------------------------------------------------
  // Export / interop / lifecycle
  // -------------------------------------------------------------------------

  /** The complete current state as one envelope-tagged delta (export/backup). */
  encodeFullState(): Uint8Array {
    this.assertAlive();
    return encodeEnvelope(this.engine.formatId, this.engine.encodeFullState(this.live));
  }

  /**
   * Advanced compatibility escape hatch for engine integrations without a
   * dedicated adapter. Ordinary consumers should use the adapter subpaths.
   * Everything written through the native document is treated as a local edit;
   * do not apply remote data through it — use {@link applyDurable}/
   * {@link applyLive} so durable bookkeeping and change provenance stay correct.
   */
  unwrap(): TDoc {
    this.assertAlive();
    return this.live;
  }

  /** Tear down observers, undo state, and both engine documents. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.teardowns) off();
    this.teardowns.clear();
    this.undoHandle?.destroy();
    this.engine.destroyDoc?.(this.live);
    this.engine.destroyDoc?.(this.shadow);
  }
}

/** Create a {@link CollabDoc} over a document-tier engine. */
export function createCollabDoc<TDoc>(engine: DocEngine<TDoc>, options?: CollabDocOptions): CollabDoc<TDoc> {
  return new CollabDoc(engine, options);
}
