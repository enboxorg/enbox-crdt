import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isEnvelope } from '../index.js';
import { DurableWriter, type DurableWriterOptions } from '../enbox/durable-writer.js';
import { createAwareness } from '../yjs1/awareness.js';
import { createYjs1Doc } from '../yjs1/index.js';

type FrameListener = (frame: Uint8Array, peerId: string) => void;
class Channel {
  updates: Uint8Array[] = [];
  sync: Uint8Array[] = [];
  heals: Uint8Array[] = [];
  awareness: Uint8Array[] = [];
  syncListeners = new Set<FrameListener>();
  awarenessListeners = new Set<FrameListener>();
  statusListeners = new Set<(status: string) => void>();
  pressureListeners = new Set<(intervalMs: number) => void>();

  broadcastUpdate(frame: Uint8Array): void { this.updates.push(frame); }
  broadcastSync(frame: Uint8Array): void { this.sync.push(frame); }
  broadcastHeal(frame: Uint8Array): void { this.heals.push(frame); }
  broadcastAwareness(frame: Uint8Array): void { this.awareness.push(frame); }
  onSync(listener: FrameListener): () => void { return this.listen(this.syncListeners, listener); }
  onAwareness(listener: FrameListener): () => void { return this.listen(this.awarenessListeners, listener); }
  onStatus(listener: (status: string) => void): () => void { return this.listen(this.statusListeners, listener); }
  onBackpressure(listener: (intervalMs: number) => void): () => void { return this.listen(this.pressureListeners, listener); }
  receiveSync(frame: Uint8Array, peerId = 'peer'): void { this.syncListeners.forEach(listener => listener(frame, peerId)); }
  receiveAwareness(frame: Uint8Array, peerId = 'peer'): void { this.awarenessListeners.forEach(listener => listener(frame, peerId)); }
  backpressure(intervalMs: number): void { this.pressureListeners.forEach(listener => listener(intervalMs)); }

  private listen<Listener>(listeners: Set<Listener>, listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
}

const documents: ReturnType<typeof createYjs1Doc>[] = [];
function document(text = '') {
  const doc = createYjs1Doc();
  documents.push(doc);
  if (text !== '') doc.insertText(0, text);
  return doc;
}
function participant(name: string) {
  const awareness = createAwareness<{ user: { name: string } }>(document());
  awareness.setLocalState({ user: { name } });
  return awareness;
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  documents.splice(0).forEach(doc => doc.destroy());
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('live document binding', () => {
  it('rejects invalid timing options before attaching channel work', () => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    const subscriptions = ['onSync', 'onAwareness', 'onStatus', 'onBackpressure'] as const;
    const spies = subscriptions.map(name => vi.spyOn(channel, name));
    const timers = vi.getTimerCount();
    for (const option of ['updateIntervalMs', 'awarenessIntervalMs', 'syncIntervalMs'] as const) {
      for (const value of [0, -1, NaN, Infinity, 2_147_483_648]) {
        expect(() => doc.connectLive(channel, {
          canWrite: () => true, awareness, [option]: value,
        })).toThrow(RangeError);
      }
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timers);
  });

  it.each([
    'onAwareness', 'onSync', 'onStatus', 'onBackpressure', 'onLocalUpdate', 'onUpdate',
  ] as const)('releases earlier work when %s subscription fails', stage => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    const failure = new Error('subscription unavailable');
    const fail = () => { throw failure; };
    const subscription = stage === 'onLocalUpdate' ? vi.spyOn(doc, stage).mockImplementation(fail)
      : stage === 'onUpdate' ? vi.spyOn(awareness, stage).mockImplementation(fail)
        : vi.spyOn(channel, stage).mockImplementation(fail);
    const timers = vi.getTimerCount();
    expect(() => doc.connectLive(channel, { canWrite: () => true, awareness })).toThrow(failure);
    expect([channel.syncListeners.size, channel.awarenessListeners.size,
      channel.statusListeners.size, channel.pressureListeners.size]).toEqual([0, 0, 0, 0]);
    expect(vi.getTimerCount()).toBe(timers);
    doc.insertText(0, 'still usable');
    expect(channel.updates).toEqual([]);
    subscription.mockRestore();
    const detach = doc.connectLive(channel, { canWrite: () => true, awareness });
    detach();
  });

  it('holds one attachment claim through setup, use, and teardown', () => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    const replacement = new Channel();
    const options = { canWrite: () => true, awareness };
    const blocked: unknown[] = [];
    const reconnect = () => {
      try { doc.connectLive(replacement, options); }
      catch (error) { blocked.push(error); }
    };
    channel.broadcastSync = reconnect;
    const detach = doc.connectLive(channel, options);
    expect(blocked).toHaveLength(1); // Initial sync cannot reenter attachment.
    reconnect();
    expect(blocked).toHaveLength(2);
    channel.broadcastAwareness = reconnect;
    detach();
    expect(blocked).toHaveLength(3); // Departure cannot attach before cleanup finishes.
    for (const error of blocked) {
      expect(error).toEqual(new Error('Document already has a live attachment. Detach it before connecting again.'));
    }
    expect([replacement.syncListeners.size, replacement.awarenessListeners.size]).toEqual([0, 0]);
    const detachReplacement = doc.connectLive(replacement, options);
    detach(); // An old detach must not release the replacement's claim.
    expect(() => doc.connectLive(new Channel(), options)).toThrow('Document already has a live attachment.');
    doc.insertText(0, 'fresh');
    expect(replacement.updates).toHaveLength(1);
    detachReplacement();
  });

  it.each(['sync', 'awareness'] as const)('releases attachment work if initial %s send destroys the document', kind => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    vi.spyOn(channel, kind === 'sync' ? 'broadcastSync' : 'broadcastAwareness')
      .mockImplementation(() => { doc.destroy(); });
    expect(() => doc.connectLive(channel, { canWrite: () => true, awareness })).toThrow(/destroyed/);
    expect([channel.syncListeners.size, channel.awarenessListeners.size,
      channel.statusListeners.size, channel.pressureListeners.size]).toEqual([0, 0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not rearm batching when the first local send destroys the document', () => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    doc.connectLive(channel, { canWrite: () => true, awareness });
    channel.broadcastUpdate = frame => { channel.updates.push(frame); doc.destroy(); };
    expect(() => doc.insertText(0, 'last edit')).not.toThrow();
    expect(channel.updates).toHaveLength(1);
    expect([channel.syncListeners.size, channel.awarenessListeners.size,
      channel.statusListeners.size, channel.pressureListeners.size]).toEqual([0, 0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detaches before borrowed awareness is destroyed, leaving the document usable', () => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    const detach = doc.connectLive(channel, { canWrite: () => true, awareness });
    awareness.setLocalState({ cursor: 1 }); // Leave a cursor send pending.
    detach();
    awareness.destroy();
    const sent = channel.awareness.length;
    channel.receiveAwareness(new Uint8Array());
    channel.receiveSync(new Uint8Array());
    vi.advanceTimersByTime(10_000);
    doc.insertText(0, 'still usable');
    expect(doc.getText()).toBe('still usable');
    expect(channel.updates).toEqual([]);
    expect(channel.awareness).toHaveLength(sent);
    expect([channel.syncListeners.size, channel.awarenessListeners.size,
      channel.statusListeners.size, channel.pressureListeners.size]).toEqual([0, 0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends SDK frames and flushes a merged trailing batch on detach', () => {
    const doc = document();
    const peer = document();
    const channel = new Channel();
    const peerChannel = new Channel();
    const detach = doc.connectLive(channel, { canWrite: () => true });
    peer.connectLive(peerChannel, { canWrite: () => true });
    expect(channel.sync).toHaveLength(1);
    expect(isEnvelope(channel.sync[0]!)).toBe(true);

    doc.insertText(0, 'local');
    expect(channel.updates).toHaveLength(1);
    expect(isEnvelope(channel.updates[0]!)).toBe(true);
    channel.receiveSync(peerChannel.sync[0]!);
    expect(channel.heals).toHaveLength(1);
    peer.applyLive(channel.heals[0]!);
    expect(peer.getText()).toBe('local');

    doc.insertText(5, ' batched');
    doc.insertText(doc.getText().length, ' edits');
    expect(channel.updates).toHaveLength(1);
    detach();
    detach();
    expect(channel.updates).toHaveLength(2);
    peer.applyLive(channel.updates[1]!);
    expect(peer.getText()).toBe('local batched edits');
    expect(peer.hasUnflushedChanges()).toBe(true);
  });

  it('removes old-room cursors and republishes preserved local awareness on reattach', () => {
    const doc = document();
    const awareness = createAwareness(doc);
    const localState = { user: { name: 'Alice' } };
    awareness.setLocalState(localState);
    const receiver = participant('Bob');
    const first = new Channel();
    const detach = doc.connectLive(first, { canWrite: () => true, awareness });
    receiver.applyUpdate(first.awareness[0]!, 'remote');
    first.receiveAwareness(receiver.encodeUpdate([receiver.clientId]));
    expect(awareness.getStates().has(receiver.clientId)).toBe(true);
    detach();
    expect(awareness.getStates().has(receiver.clientId)).toBe(false);
    expect(awareness.getLocalState()).toEqual(localState);
    receiver.applyUpdate(first.awareness.at(-1)!, 'remote');
    expect(receiver.getStates().has(awareness.clientId)).toBe(false);

    const second = new Channel();
    doc.connectLive(second, { canWrite: () => true, awareness });
    expect(second.awareness).toHaveLength(1);
    receiver.applyUpdate(second.awareness[0]!, 'remote');
    expect(receiver.getStates().get(awareness.clientId)).toEqual(localState);
  });

  it('keeps one cursor per peer while preserving separate sessions of one user', () => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    doc.connectLive(channel, { canWrite: () => true, awareness, broadcast: false });
    const first = participant('Alice');
    const replacement = participant('Alice');
    const otherSession = participant('Alice');
    channel.receiveAwareness(first.encodeUpdate([first.clientId]), 'session-a');
    channel.receiveAwareness(replacement.encodeUpdate([replacement.clientId]), 'session-a');
    expect(awareness.getStates().has(first.clientId)).toBe(false);
    expect(awareness.getStates().has(replacement.clientId)).toBe(true);
    first.removeStates([first.clientId]);
    channel.receiveAwareness(first.encodeUpdate([first.clientId]), 'session-a');
    channel.receiveAwareness(otherSession.encodeUpdate([otherSession.clientId]), 'session-b');
    const remoteClients = [...awareness.getStates().keys()].filter(id => id !== awareness.clientId);
    expect(remoteClients.sort()).toEqual([replacement.clientId, otherSession.clientId].sort());
  });

  it('keeps receive-only attachments silent through edits and teardown', () => {
    const doc = document();
    const awareness = createAwareness(doc);
    awareness.setLocalState({ user: { name: 'Viewer' } });
    const channel = new Channel();
    const detach = doc.connectLive(channel, { canWrite: () => true, awareness, broadcast: false });
    const writer = participant('Writer');
    channel.receiveAwareness(writer.encodeUpdate([writer.clientId]));
    expect(awareness.getStates().has(writer.clientId)).toBe(true);
    doc.insertText(0, 'local-only');
    vi.advanceTimersByTime(5_000);
    detach();
    expect([channel.updates, channel.sync, channel.heals, channel.awareness]).toEqual([[], [], [], []]);
    expect(awareness.getStates().has(writer.clientId)).toBe(false);
  });

  it('respects backpressure for batched edits and cursor updates without echoing remote changes', () => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    doc.connectLive(channel, { canWrite: () => true, awareness });
    channel.backpressure(1_000);
    for (const invalid of [NaN, Infinity, -1, 2_147_483_648]) channel.backpressure(invalid);
    const remote = document('remote');
    doc.applyLive(remote.encodeFullState());
    doc.applyDurable(remote.encodeFullState(), { recordId: 'stored' });
    expect(channel.updates).toEqual([]);
    expect(doc.hasUnflushedChanges()).toBe(false);
    doc.insertText(6, ' local');
    doc.insertText(doc.getText().length, ' batch');
    const initialAwareness = channel.awareness.length;
    awareness.setLocalState({ cursor: 1 });
    awareness.setLocalState({ cursor: 2 });
    vi.advanceTimersByTime(999);
    expect(channel.updates).toHaveLength(1);
    expect(channel.awareness).toHaveLength(initialAwareness);
    vi.advanceTimersByTime(1);
    expect(channel.updates).toHaveLength(2);
    expect(channel.awareness).toHaveLength(initialAwareness + 1);
    const receiver = createAwareness(document());
    receiver.applyUpdate(channel.awareness.at(-1)!, 'remote');
    expect(receiver.getStates().get(awareness.clientId)).toEqual({ cursor: 2 });
    expect(doc.hasUnflushedChanges()).toBe(true);
  });

  it.each(['throw', 'reject'] as const)('keeps autosave running when transport sends %s', async failureMode => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    const sends = ['broadcastUpdate', 'broadcastSync', 'broadcastHeal', 'broadcastAwareness'] as const;
    for (const method of sends) {
      const capture = channel[method].bind(channel);
      channel[method] = frame => {
        capture(frame);
        const failure = new Error('transport unavailable');
        if (failureMode === 'throw') throw failure;
        return Promise.reject(failure);
      };
    }
    const detach = doc.connectLive(channel, { canWrite: () => true, awareness });
    const create = vi.fn<DurableWriterOptions['create']>(async () => ({
      id: 'durable', timestamp: '2026-01-01T00:00:00.000000Z',
    }));
    const writer = new DurableWriter({
      doc, create, timers: { idleMs: 2_000, backstopMs: 30_000, convergenceMs: 1_000 },
    });
    // This observer must still run after the live attachment's failed send.
    const offLocal = doc.onLocalUpdate(() => writer.onLocalChange());
    try {
      expect(() => doc.insertText(0, 'first')).not.toThrow();
      expect(() => doc.insertText(5, ' batch')).not.toThrow();
      awareness.setLocalState({ cursor: 1 });
      const peer = document();
      const peerChannel = new Channel();
      peer.connectLive(peerChannel, { canWrite: () => true });
      expect(() => channel.receiveSync(peerChannel.sync[0]!)).not.toThrow();

      await vi.advanceTimersByTimeAsync(3_000);
      expect(channel.updates).toHaveLength(2);
      expect(channel.heals).toHaveLength(1);
      expect(channel.sync).toHaveLength(2);
      expect(channel.awareness).toHaveLength(2);
      expect(create).toHaveBeenCalledOnce(); // Autosave ran before any explicit drain.
      await writer.drain();
      expect(doc.hasUnflushedChanges()).toBe(false);
      peer.applyDurable(create.mock.calls[0]![0].data, { recordId: 'durable' });
      expect(peer.getText()).toBe('first batch');
    } finally {
      offLocal();
      writer.dispose();
      detach();
    }
    expect([channel.syncListeners.size, channel.awarenessListeners.size,
      channel.statusListeners.size, channel.pressureListeners.size]).toEqual([0, 0, 0, 0]);
  });

  it('checks current peer permission on every sync probe and awareness update', () => {
    const doc = document('owner');
    const awareness = createAwareness(doc);
    const channel = new Channel();
    const peer = document();
    const peerChannel = new Channel();
    const peerAwareness = createAwareness(peer);
    let admitted = false;
    doc.connectLive(channel, { canWrite: id => admitted && id === 'writer', awareness });
    peer.connectLive(peerChannel, { canWrite: () => true });
    const send = () => {
      channel.receiveSync(peerChannel.sync[0]!, 'writer');
      channel.receiveAwareness(peerAwareness.encodeUpdate([peerAwareness.clientId]), 'writer');
    };
    peerAwareness.setLocalState({ cursor: 1 });
    send();
    expect(channel.heals).toHaveLength(0);
    expect(awareness.getStates().has(peerAwareness.clientId)).toBe(false);
    admitted = true;
    send();
    expect(channel.heals).toHaveLength(1);
    expect(awareness.getStates().get(peerAwareness.clientId)).toEqual({ cursor: 1 });
    admitted = false;
    peerAwareness.setLocalState({ cursor: 2 });
    send();
    expect(channel.heals).toHaveLength(1);
    expect(awareness.getStates().get(peerAwareness.clientId)).toEqual({ cursor: 1 });
  });

  it('flushes captured edits and detaches listeners and timers when the document is destroyed', () => {
    const doc = document();
    const receiver = document();
    const awareness = createAwareness(doc);
    awareness.setLocalState({ cursor: 1 });
    const receiverAwareness = createAwareness(receiver);
    const channel = new Channel();
    const detach = doc.connectLive(channel, { canWrite: () => true, awareness });
    receiverAwareness.applyUpdate(channel.awareness[0]!, 'remote');
    doc.insertText(0, 'first');
    doc.insertText(5, ' last');
    doc.destroy();
    expect(channel.updates).toHaveLength(2);
    channel.updates.forEach(frame => receiver.applyLive(frame));
    expect(receiver.getText()).toBe('first last');
    receiverAwareness.applyUpdate(channel.awareness.at(-1)!, 'remote');
    expect(receiverAwareness.getStates().has(awareness.clientId)).toBe(false);
    expect([channel.syncListeners.size, channel.awarenessListeners.size,
      channel.statusListeners.size, channel.pressureListeners.size]).toEqual([0, 0, 0, 0]);
    expect(vi.getTimerCount()).toBe(1); // Only the receiver's awareness timer remains.
    const sent = [channel.updates.length, channel.sync.length, channel.awareness.length];
    detach(); // The returned teardown is a no-op after automatic detachment.
    vi.advanceTimersByTime(10_000);
    expect([channel.updates.length, channel.sync.length, channel.awareness.length]).toEqual(sent);
  });
});
