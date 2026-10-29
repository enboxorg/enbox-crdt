import type { MergeEngine } from '../engine.js';
import type { CollabAwareness } from '../yjs1/awareness.js';
import type { SyncChannel } from './index.js';

import { decodeEnvelope, encodeEnvelope } from '../envelope.js';
import { wireLiveSync } from './index.js';

/** Channel operations used by a document's live attachment; the caller owns the channel. */
export interface LiveChannel extends Omit<SyncChannel, 'onSync'> {
  /** Send one enveloped local-update batch. Delivery remains best effort. */
  broadcastUpdate(frame: Uint8Array): void;
  /** Supply the authenticated transport peer, not a self-asserted DID from the payload. */
  onSync(handler: (frame: Uint8Array, peerId: string) => void): () => void;
  /** Optional transport pressure adjusts subsequent update and cursor batches. */
  onBackpressure?(handler: (intervalMs: number) => void): () => void;
  /** Both awareness operations are required when an awareness handle is attached. */
  broadcastAwareness?(frame: Uint8Array): void;
  /** Receive cursor frames with the authenticated transport peer id. */
  onAwareness?(handler: (frame: Uint8Array, peerId: string) => void): () => void;
}

/** Policy for one live attachment. Incoming document frames remain caller-admitted via applyLive. */
export interface LiveConnectionOptions<State extends object = Record<string, unknown>> {
  /** Check current permission for each incoming sync/cursor frame; unknown peers must be denied. */
  canWrite(peerId: string): boolean;
  /** False receives cursors without sending updates, probes, heal replies, or cursors. Default true. */
  broadcast?: boolean;
  /** Borrowed document-bound awareness; detaching preserves local state and removes remote cursors. */
  awareness?: CollabAwareness<State>;
  /** Local edits send immediately, then coalesce at this cadence. Default 200 ms. */
  updateIntervalMs?: number;
  /** Cursor updates coalesce at this cadence. Default 300 ms. */
  awarenessIntervalMs?: number;
  /** State-vector probe cadence. Default 3000 ms. */
  syncIntervalMs?: number;
}

/** @internal Shared by the document convenience method; no document/channel ownership is transferred. */
export function bindLiveDocument<TDoc, State extends object>(
  engine: MergeEngine<TDoc>,
  doc: TDoc,
  onLocalUpdate: (handler: (frame: Uint8Array) => void) => () => void,
  isCurrent: () => boolean,
  channel: LiveChannel,
  options: LiveConnectionOptions<State>,
): () => void {
  const awareness = options.awareness;
  if (awareness !== undefined && (channel.onAwareness === undefined || channel.broadcastAwareness === undefined)) {
    throw new TypeError('Live awareness requires channel.onAwareness and channel.broadcastAwareness.');
  }
  const broadcast = options.broadcast !== false;
  const updateInterval = options.updateIntervalMs ?? 200;
  const awarenessInterval = options.awarenessIntervalMs ?? 300;
  let updateDelay = updateInterval;
  let awarenessDelay = awarenessInterval;
  let active = true;
  let pendingUpdates: Uint8Array[] = [];
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let awarenessTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanups: Array<() => void> = [];
  const remoteClientByPeer = new Map<string, number>();
  const current = (): boolean => active && isCurrent();
  // Browser departure is optional; importing the package does not require a DOM.
  const page = (globalThis as typeof globalThis & { window?: EventTarget }).window;

  const sendUpdates = (): void => {
    const batch = pendingUpdates;
    pendingUpdates = [];
    if (batch.length > 1 && engine.mergeDeltas !== undefined) {
      // These frames came from this document; merge only captured local operations.
      const payload = engine.mergeDeltas(batch.map(frame => decodeEnvelope(frame).payload));
      channel.broadcastUpdate(encodeEnvelope(engine.formatId, payload));
    } else {
      for (const frame of batch) channel.broadcastUpdate(frame);
    }
  };
  const flushUpdates = (): void => {
    updateTimer = undefined;
    if (!current() || pendingUpdates.length === 0) return;
    sendUpdates();
    if (current()) updateTimer = setTimeout(flushUpdates, updateDelay);
  };
  const sendAwareness = (): void => {
    awarenessTimer = undefined;
    if (current() && awareness !== undefined) {
      channel.broadcastAwareness!(awareness.encodeUpdate([awareness.clientId]));
    }
  };
  const announceDeparture = (): void => {
    if (!broadcast || awareness === undefined) return;
    try {
      awareness.removeStates([awareness.clientId], 'teardown');
      channel.broadcastAwareness!(awareness.encodeUpdate([awareness.clientId]));
    } catch { /* Cursor expiry is the fallback for best-effort departure. */ }
  };
  const detach = (): void => {
    if (!active) return;
    active = false;
    // Always release transport work, even if borrowed awareness was already destroyed.
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* Continue releasing the remaining live listeners. */ }
    }
    clearTimeout(updateTimer);
    clearTimeout(awarenessTimer);
    if (awareness !== undefined) {
      try {
        const localState = awareness.getLocalState();
        announceDeparture();
        const remoteIds = [...awareness.getStates().keys()].filter(id => id !== awareness.clientId);
        if (remoteIds.length > 0) awareness.removeStates(remoteIds, 'teardown');
        if (broadcast && localState !== null) awareness.setLocalState(localState);
      } catch { /* Document/awareness destruction may have preceded a failed attachment. */ }
    }
    remoteClientByPeer.clear();
    try { sendUpdates(); } catch { /* Durable storage remains responsible for retained edits. */ }
  };

  try {
    if (awareness !== undefined) {
      cleanups.push(channel.onAwareness!((frame, peerId) => {
        if (!current() || !options.canWrite(peerId)) return;
        const added: number[] = [];
        const removed: number[] = [];
        const stopCapture = awareness.onUpdate((change, origin) => {
          if (origin !== 'remote') return;
          added.push(...change.added, ...change.updated);
          removed.push(...change.removed);
        });
        try {
          awareness.applyUpdate(frame, 'remote');
        } catch {
          return; // Ignore malformed peer cursor frames.
        } finally { stopCapture(); }
        const clientId = added.at(-1);
        if (clientId !== undefined) {
          const previous = remoteClientByPeer.get(peerId);
          const superseded = new Set(added.slice(0, -1));
          if (previous !== undefined && previous !== clientId) superseded.add(previous);
          superseded.delete(awareness.clientId);
          if (superseded.size > 0) awareness.removeStates([...superseded], 'remote');
          remoteClientByPeer.set(peerId, clientId);
        }
        for (const id of removed) {
          if (remoteClientByPeer.get(peerId) === id) remoteClientByPeer.delete(peerId);
        }
      }));
    }
    if (broadcast) {
      cleanups.push(wireLiveSync(engine, {
        broadcastSync: frame => channel.broadcastSync(frame),
        broadcastHeal: frame => channel.broadcastHeal(frame),
        onSync: handler => channel.onSync((frame, peerId) => {
          if (current() && options.canWrite(peerId)) handler(frame);
        }),
        onStatus: channel.onStatus === undefined ? undefined : handler => channel.onStatus!(handler),
      }, () => doc, current, { intervalMs: options.syncIntervalMs }));
      if (channel.onBackpressure !== undefined) {
        cleanups.push(channel.onBackpressure(interval => {
          if (!current() || !Number.isFinite(interval)) return;
          updateDelay = Math.max(updateInterval, interval);
          awarenessDelay = Math.max(awarenessInterval, interval);
        }));
      }
      cleanups.push(onLocalUpdate(frame => {
        if (!current()) return;
        pendingUpdates.push(frame);
        if (updateTimer !== undefined) return;
        sendUpdates();
        if (current()) updateTimer = setTimeout(flushUpdates, updateDelay);
      }));
      if (awareness !== undefined) {
        const localState = awareness.getLocalState();
        if (localState !== null) awareness.setLocalState(localState);
        cleanups.push(awareness.onUpdate((_change, origin) => {
          if (current() && origin !== 'remote' && awarenessTimer === undefined) {
            awarenessTimer = setTimeout(sendAwareness, awarenessDelay);
          }
        }));
        if (localState !== null) sendAwareness();
        page?.addEventListener('pagehide', announceDeparture);
        cleanups.push(() => page?.removeEventListener('pagehide', announceDeparture));
      }
    }
    return detach;
  } catch (error) {
    detach();
    throw error;
  }
}
