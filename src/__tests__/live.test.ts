import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { decodeEnvelope, encodeEnvelope } from '../envelope.js';
import { wireLiveSync } from '../live/index.js';
import { yjs1 } from '../yjs1/advanced.js';

interface FakeChannel {
  syncFrames: Uint8Array[];
  healFrames: Uint8Array[];
  emitSync(frame: Uint8Array): void;
  emitStatus(status: string): void;
  channel: {
    broadcastSync(frame: Uint8Array): void;
    onSync(handler: (frame: Uint8Array) => void): () => void;
    broadcastHeal(frame: Uint8Array): void;
    onStatus(handler: (status: string) => void): () => void;
  };
}

function fakeChannel(): FakeChannel {
  const syncFrames: Uint8Array[] = [];
  const healFrames: Uint8Array[] = [];
  const syncHandlers = new Set<(frame: Uint8Array) => void>();
  const statusHandlers = new Set<(status: string) => void>();
  return {
    syncFrames,
    healFrames,
    emitSync: (frame) => {
      for (const h of syncHandlers) h(frame);
    },
    emitStatus: (status) => {
      for (const h of statusHandlers) h(status);
    },
    channel: {
      broadcastSync: (frame) => {
        syncFrames.push(frame);
      },
      onSync: (handler) => {
        syncHandlers.add(handler);
        return () => syncHandlers.delete(handler);
      },
      broadcastHeal: (frame) => {
        healFrames.push(frame);
      },
      onStatus: (handler) => {
        statusHandlers.add(handler);
        return () => statusHandlers.delete(handler);
      },
    },
  };
}

describe('wireLiveSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const docWith = (text: string): Y.Doc => {
    const doc = new Y.Doc();
    doc.clientID = 42;
    if (text) doc.getText('content').insert(0, text);
    return doc;
  };

  it('probes immediately, per interval, and on reconnect — with enveloped state vectors', () => {
    const fake = fakeChannel();
    const doc = docWith('hello');
    const off = wireLiveSync(yjs1, fake.channel, () => doc, () => true, { intervalMs: 1000 });

    expect(fake.syncFrames.length).toBe(1);
    const probe = decodeEnvelope(fake.syncFrames[0] as Uint8Array);
    expect(probe.format).toBe('yjs1');

    vi.advanceTimersByTime(2000);
    expect(fake.syncFrames.length).toBe(3);

    fake.emitStatus('connected');
    expect(fake.syncFrames.length).toBe(4);

    off();
    vi.advanceTimersByTime(5000);
    expect(fake.syncFrames.length).toBe(4);
    doc.destroy();
  });

  it('replies with a conservative diff on the heal lane', () => {
    const fake = fakeChannel();
    const doc = docWith('hello world');
    wireLiveSync(yjs1, fake.channel, () => doc, () => true, { intervalMs: 60_000 });

    const behindPeer = new Y.Doc();
    fake.emitSync(encodeEnvelope('yjs1', Y.encodeStateVector(behindPeer)));

    expect(fake.healFrames.length).toBe(1);
    const heal = decodeEnvelope(fake.healFrames[0] as Uint8Array);
    expect(heal.format).toBe('yjs1');
    Y.applyUpdate(behindPeer, heal.payload);
    expect(behindPeer.getText('content').toString()).toBe('hello world');
    behindPeer.destroy();
    doc.destroy();
  });

  it('conservatively re-sends delete sets a peer state vector cannot describe', () => {
    const fake = fakeChannel();
    const doc = docWith('hello');
    doc.getText('content').delete(0, 1); // non-empty delete set
    wireLiveSync(yjs1, fake.channel, () => doc, () => true, { intervalMs: 60_000 });

    fake.emitSync(encodeEnvelope('yjs1', Y.encodeStateVector(doc)));
    expect(fake.healFrames.length).toBe(1);
    const { payload } = decodeEnvelope(fake.healFrames[0] as Uint8Array);
    expect(yjs1.applyDelta(doc, payload)).toBe(false); // harmlessly idempotent
    doc.destroy();
  });

  it('heals a fully-dropped deletion-only update', () => {
    const fake = fakeChannel();
    const source = docWith('hello');
    const target = new Y.Doc();
    target.clientID = 43;
    Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
    source.getText('content').delete(0, 1); // state vector does not advance

    wireLiveSync(yjs1, fake.channel, () => source, () => true, { intervalMs: 60_000 });
    fake.emitSync(encodeEnvelope('yjs1', Y.encodeStateVector(target)));

    expect(fake.healFrames.length).toBe(1);
    const { payload } = decodeEnvelope(fake.healFrames[0] as Uint8Array);
    expect(yjs1.applyDelta(target, payload)).toBe(true);
    expect(target.getText('content').toString()).toBe('ello');
    target.destroy();
    source.destroy();
  });

  it('ignores non-envelope frames, foreign formats, and garbage state vectors', () => {
    const fake = fakeChannel();
    const doc = docWith('hello');
    wireLiveSync(yjs1, fake.channel, () => doc, () => true, { intervalMs: 60_000 });

    fake.emitSync(Uint8Array.from([1, 2, 3])); // not an envelope
    fake.emitSync(encodeEnvelope('loro1', Y.encodeStateVector(new Y.Doc()))); // foreign format
    fake.emitSync(encodeEnvelope('yjs1', Uint8Array.from([255, 255, 255, 255]))); // garbage SV
    fake.emitSync(encodeEnvelope('yjs1', new Uint8Array(0)).subarray(0, 5)); // corrupt envelope

    expect(fake.healFrames.length).toBe(0);
    doc.destroy();
  });

  it('resolves the doc lazily and respects isCurrent', () => {
    const fake = fakeChannel();
    let doc: Y.Doc | undefined;
    let current = true;
    wireLiveSync(yjs1, fake.channel, () => doc, () => current, { intervalMs: 1000 });

    expect(fake.syncFrames.length).toBe(0); // no doc yet — no probe

    doc = docWith('late');
    vi.advanceTimersByTime(1000);
    expect(fake.syncFrames.length).toBe(1);

    current = false;
    vi.advanceTimersByTime(1000);
    expect(fake.syncFrames.length).toBe(1);
    doc.destroy();
  });

  it("pauses probing on 'closed' and resumes — probe plus interval — on reconnect", () => {
    const fake = fakeChannel();
    const doc = docWith('hello');
    const off = wireLiveSync(yjs1, fake.channel, () => doc, () => true, { intervalMs: 1000 });
    expect(fake.syncFrames.length).toBe(1);

    fake.emitStatus('closed');
    vi.advanceTimersByTime(5000);
    expect(fake.syncFrames.length).toBe(1);

    fake.emitStatus('connected'); // immediate reconcile…
    expect(fake.syncFrames.length).toBe(2);
    vi.advanceTimersByTime(2000); // …and the periodic probe is running again
    expect(fake.syncFrames.length).toBe(4);

    off();
    fake.emitStatus('connected'); // a torn-down loop must not resurrect
    vi.advanceTimersByTime(5000);
    expect(fake.syncFrames.length).toBe(4);
    doc.destroy();
  });
});
