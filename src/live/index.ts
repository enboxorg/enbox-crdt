/**
 * Transport-agnostic state-vector reconciliation — the loss-tolerance layer
 * for realtime channels.
 *
 * Incremental update frames over lossy transports (public Nostr relays,
 * WebRTC data channels) are a LATENCY optimization: a dropped frame would
 * otherwise stall the receiving document until the durable flush heals it.
 * Reconciliation makes loss a non-event: periodically — and immediately on
 * (re)connect — a peer broadcasts its state vector; any peer holding
 * operations it lacks replies with exactly that diff.
 *
 * All frames are envelope-tagged: sync probes carry the format's state-vector
 * encoding; heal replies carry delta payloads. A frame in another format is
 * ignored (fail closed) — a mixed-format room cannot corrupt a document.
 *
 * @module
 */

import type { MergeEngine } from '../engine.js';
import { encodeEnvelope, tryDecodeEnvelope } from '../envelope.js';

/** Default reconciliation cadence: imperceptible heal latency, negligible cost. */
export const LIVE_SYNC_INTERVAL_MS = 3000;

/**
 * The channel surface reconciliation needs — structural, so any transport
 * (Nostr room, BroadcastChannel, WebSocket, test fake) can supply it.
 * `broadcastHeal` should ride a lane that outranks ordinary update traffic:
 * the peer that needs a heal is the one whose update stream stalled.
 */
export interface SyncChannel {
  /** Broadcast a sync probe frame (enveloped state vector). */
  broadcastSync(frame: Uint8Array): void;
  /** Subscribe to inbound sync probe frames. Returns an unsubscribe. */
  onSync(handler: (frame: Uint8Array) => void): () => void;
  /** Broadcast a heal frame (enveloped delta) toward lagging peers. */
  broadcastHeal(frame: Uint8Array): void;
  /** Optional connection-status feed; 'connected' triggers an immediate probe. */
  onStatus?(handler: (status: 'connected' | 'closed' | string) => void): () => void;
}

/** Options for {@link wireLiveSync}. */
export interface LiveSyncOptions {
  /** Probe cadence in milliseconds. Defaults to {@link LIVE_SYNC_INTERVAL_MS}. */
  intervalMs?: number;
}

/**
 * Wire state-vector reconciliation onto a channel. `getDoc` is resolved lazily
 * every tick so one loop covers a document whether it is edit-open, headless,
 * or a read-only viewer copy. `isCurrent` guards a torn-down handle still
 * firing. Returns a teardown.
 *
 * Behavior:
 * - probes immediately, on every `intervalMs` tick, and on `'connected'`;
 * - replies to a behind-peer's probe with exactly the missing diff on the heal
 *   lane — and sends NOTHING when the probe shows a converged peer, including
 *   converged documents that contain deletions (content-aware emptiness via
 *   the engine, so deletion-bearing rooms do not spray no-op heals);
 * - ignores frames that are not envelopes, are in another format, or carry
 *   state vectors the engine rejects (non-member garbage).
 */
export function wireLiveSync<TDoc>(
  engine: MergeEngine<TDoc>,
  channel: SyncChannel,
  getDoc: () => TDoc | undefined,
  isCurrent: () => boolean,
  options: LiveSyncOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? LIVE_SYNC_INTERVAL_MS;

  const probe = (): void => {
    const doc = getDoc();
    if (doc === undefined || !isCurrent()) return;
    channel.broadcastSync(encodeEnvelope(engine.formatId, engine.encodeStateVector(doc)));
  };

  const offSync = channel.onSync((frame) => {
    const doc = getDoc();
    if (doc === undefined || !isCurrent()) return;
    let envelope;
    try {
      envelope = tryDecodeEnvelope(frame);
    } catch {
      return; // corrupt envelope — ignore
    }
    if (envelope === null || envelope.format !== engine.formatId) return; // fail closed
    let diff: Uint8Array | null;
    try {
      diff = engine.encodeDiff(doc, envelope.payload);
    } catch {
      return; // garbage state vector from a non-member frame — ignore
    }
    if (diff !== null) {
      channel.broadcastHeal(encodeEnvelope(engine.formatId, diff));
    }
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const offStatus = channel.onStatus?.((status) => {
    if (status === 'connected' && !stopped) {
      // A reconnect can leave us behind by whatever was missed while the
      // socket was down — reconcile the moment we're back, not a tick later,
      // and resume the periodic probe if 'closed' had paused it.
      probe();
      timer ??= setInterval(probe, intervalMs);
    }
    if (status === 'closed' && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  });

  probe(); // heal any gap that predates this wiring
  timer = setInterval(probe, intervalMs);

  return () => {
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    offSync();
    offStatus?.();
  };
}
