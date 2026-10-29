/**
 * Transport-agnostic state-vector reconciliation — the loss-tolerance layer
 * for realtime channels.
 *
 * Incremental update frames over lossy transports (public Nostr relays,
 * WebRTC data channels) are a LATENCY optimization: a dropped frame would
 * otherwise stall the receiving document until the durable flush heals it.
 * Reconciliation makes loss a non-event: periodically — and immediately on
 * (re)connect — a peer broadcasts its state vector; any peer that may hold
 * operations it lacks replies with a diff.
 *
 * All frames are envelope-tagged: sync probes carry the format's state-vector
 * encoding; heal replies carry delta payloads. A frame in another format is
 * ignored (fail closed) — a mixed-format room cannot corrupt a document.
 *
 * @module
 */

import type { MergeEngine } from '../engine.js';
import { encodeEnvelope, tryDecodeEnvelope } from '../envelope.js';

export type { LiveChannel, LiveConnectionOptions } from './binding.js';

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
 * - replies to a behind-peer's probe with the missing diff on the heal lane;
 *   formats whose state vector omits an operation class may conservatively
 *   include it. yjs1 therefore re-sends its idempotent delete set, because the
 *   probe cannot distinguish a converged peer from one missing only a deletion;
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
  let stopped = false;

  const probe = (): void => {
    if (stopped || !isCurrent()) return;
    const doc = getDoc();
    if (doc === undefined) return;
    channel.broadcastSync(encodeEnvelope(engine.formatId, engine.encodeStateVector(doc)));
  };

  const offSync = channel.onSync((frame) => {
    if (stopped || !isCurrent()) return;
    const doc = getDoc();
    if (doc === undefined) return;
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
  let offStatus: (() => void) | undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    try { offSync(); } finally { offStatus?.(); }
  };
  try {
    offStatus = channel.onStatus?.((status) => {
      if (status === 'connected' && !stopped) {
        // Reconnect probes immediately and resumes periodic reconciliation.
        probe();
        if (!stopped && isCurrent()) timer ??= setInterval(probe, intervalMs);
      }
      if (status === 'closed' && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    });
    probe(); // heal any gap that predates this wiring
    if (!stopped && isCurrent()) timer ??= setInterval(probe, intervalMs);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
