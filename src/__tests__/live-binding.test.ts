import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isEnvelope } from '../index.js';
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
  it('releases partial channel subscriptions when attachment fails', () => {
    const doc = document();
    const awareness = createAwareness(doc);
    const channel = new Channel();
    const failure = new Error('status unavailable');
    vi.spyOn(channel, 'onStatus').mockImplementation(() => { throw failure; });
    expect(() => doc.connectLive(channel, { canWrite: () => true, awareness })).toThrow(failure);
    expect([channel.syncListeners.size, channel.awarenessListeners.size]).toEqual([0, 0]);
    doc.insertText(0, 'still usable');
    expect(channel.updates).toEqual([]);
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
    detach();
    expect(channel.updates).toHaveLength(2);
    channel.updates.forEach(frame => receiver.applyLive(frame));
    expect(receiver.getText()).toBe('first last');
    receiverAwareness.applyUpdate(channel.awareness.at(-1)!, 'remote');
    expect(receiverAwareness.getStates().has(awareness.clientId)).toBe(false);
    expect([channel.syncListeners.size, channel.awarenessListeners.size,
      channel.statusListeners.size, channel.pressureListeners.size]).toEqual([0, 0, 0, 0]);
    const sent = [channel.updates.length, channel.sync.length, channel.awareness.length];
    vi.advanceTimersByTime(10_000);
    expect([channel.updates.length, channel.sync.length, channel.awareness.length]).toEqual(sent);
  });
});
