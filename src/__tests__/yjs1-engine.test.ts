import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { applyEnvelope } from '../engine.js';
import { encodeEnvelope } from '../envelope.js';
import { yjs1 } from '../yjs1/index.js';

/** Deterministic Fisher-Yates with a tiny LCG, for permutation testing. */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

function docWithClient(clientID: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return doc;
}

/** Three writers produce a pile of concurrent deltas over a shared base. */
function concurrentDeltas(): { deltas: Uint8Array[]; expectedText: string } {
  const a = docWithClient(1);
  a.getText('content').insert(0, 'base text here');
  const base = Y.encodeStateAsUpdate(a);
  const baseSv = Y.encodeStateVector(a);

  const b = docWithClient(2);
  const c = docWithClient(3);
  Y.applyUpdate(b, base);
  Y.applyUpdate(c, base);

  a.getText('content').insert(4, ' alpha');
  b.getText('content').delete(0, 4);
  c.getText('content').insert(14, ' gamma');

  const deltas = [
    base,
    Y.encodeStateAsUpdate(a, baseSv),
    Y.encodeStateAsUpdate(b, baseSv),
    Y.encodeStateAsUpdate(c, baseSv),
  ];

  const ref = new Y.Doc();
  for (const d of deltas) Y.applyUpdate(ref, d);
  const expectedText = ref.getText('content').toString();
  for (const doc of [a, b, c, ref]) doc.destroy();
  return { deltas, expectedText };
}

describe('yjs1 engine', () => {
  it('application is commutative and idempotent across permutations with duplicates', () => {
    const { deltas, expectedText } = concurrentDeltas();
    for (const seed of [1, 2, 3, 4, 5]) {
      const order = seededShuffle([...deltas, ...deltas], seed); // duplicates included
      const doc = yjs1.createDoc();
      for (const delta of order) yjs1.applyDelta(doc, delta);
      expect(doc.getText('content').toString()).toBe(expectedText);
      yjs1.destroyDoc?.(doc);
    }
  });

  it('applyDelta reports advancement, and re-application reports none', () => {
    const source = docWithClient(5);
    source.getText('content').insert(0, 'hi');
    const update = Y.encodeStateAsUpdate(source);

    const doc = yjs1.createDoc();
    expect(yjs1.applyDelta(doc, update)).toBe(true);
    expect(yjs1.applyDelta(doc, update)).toBe(false); // own echo — no advance
    source.destroy();
    yjs1.destroyDoc?.(doc);
  });

  it('a full-state payload is a valid delta (snapshot-as-delta invariant)', () => {
    const source = docWithClient(5);
    source.getText('content').insert(0, 'snapshot me');
    const snapshot = yjs1.encodeFullState(source);

    const doc = yjs1.createDoc();
    yjs1.applyDelta(doc, snapshot);
    expect(doc.getText('content').toString()).toBe('snapshot me');
    source.destroy();
    yjs1.destroyDoc?.(doc);
  });

  it('encodeDiff returns null for a converged peer even when deletions exist (heal-spam guard)', () => {
    const doc = docWithClient(6);
    doc.getText('content').insert(0, 'hello');
    doc.getText('content').delete(0, 1); // delete set is now non-empty

    // A peer that has seen everything: its SV equals ours.
    const peerSv = yjs1.encodeStateVector(doc);

    // Yjs re-emits the full delete set in every diff, so the raw diff is
    // larger than an empty update — the naive byteLength test would heal-spam.
    const rawDiff = Y.encodeStateAsUpdate(doc, peerSv);
    expect(rawDiff.byteLength).toBeGreaterThan(2);

    expect(yjs1.encodeDiff(doc, peerSv)).toBeNull();
    doc.destroy();
  });

  it('encodeDiff returns the missing operations for a behind peer', () => {
    const doc = docWithClient(6);
    doc.getText('content').insert(0, 'hello');
    const midSv = yjs1.encodeStateVector(doc);
    doc.getText('content').insert(5, ' world');

    const diff = yjs1.encodeDiff(doc, midSv);
    expect(diff).not.toBeNull();

    const behind = yjs1.createDoc();
    yjs1.applyDelta(behind, Y.encodeStateAsUpdate(doc, yjs1.encodeStateVector(behind)));
    expect(behind.getText('content').toString()).toBe('hello world');
    doc.destroy();
    yjs1.destroyDoc?.(behind);
  });

  it('encodeDiff throws on a garbage state vector', () => {
    const doc = yjs1.createDoc();
    expect(() => yjs1.encodeDiff(doc, Uint8Array.from([255, 255, 255, 255]))).toThrow();
    yjs1.destroyDoc?.(doc);
  });

  it('threads the transaction origin through applyDelta', () => {
    const source = docWithClient(5);
    source.getText('content').insert(0, 'x');
    const update = Y.encodeStateAsUpdate(source);

    const doc = yjs1.createDoc();
    const origins: unknown[] = [];
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      origins.push(origin);
    });
    const REMOTE = Symbol('remote');
    yjs1.applyDelta(doc, update, REMOTE);
    expect(origins).toEqual([REMOTE]);
    source.destroy();
    yjs1.destroyDoc?.(doc);
  });

  it('mergeDeltas coalesces payloads into one equivalent payload', () => {
    const { deltas, expectedText } = concurrentDeltas();
    const merged = yjs1.mergeDeltas?.(deltas);
    expect(merged).toBeDefined();
    const doc = yjs1.createDoc();
    yjs1.applyDelta(doc, merged as Uint8Array);
    expect(doc.getText('content').toString()).toBe(expectedText);
    yjs1.destroyDoc?.(doc);
  });

  it('applyEnvelope applies matching frames and fails closed otherwise', () => {
    const source = docWithClient(5);
    source.getText('content').insert(0, 'enveloped');
    const update = Y.encodeStateAsUpdate(source);

    const doc = yjs1.createDoc();
    const ok = applyEnvelope(yjs1, doc, encodeEnvelope('yjs1', update));
    expect(ok).toEqual({ applied: true, advanced: true, format: 'yjs1' });
    expect(doc.getText('content').toString()).toBe('enveloped');

    const mismatch = applyEnvelope(yjs1, doc, encodeEnvelope('loro1', update));
    expect(mismatch).toEqual({ applied: false, reason: 'format-mismatch', format: 'loro1' });

    const raw = applyEnvelope(yjs1, doc, update);
    expect(raw).toEqual({ applied: false, reason: 'not-an-envelope' });

    const invalid = applyEnvelope(yjs1, doc, encodeEnvelope('yjs1', Uint8Array.from([250, 250, 250])));
    expect(invalid).toEqual({ applied: false, reason: 'invalid-payload', format: 'yjs1' });

    const futureVersion = encodeEnvelope('yjs1', update).slice();
    futureVersion[4] = 2;
    expect(applyEnvelope(yjs1, doc, futureVersion)).toEqual({
      applied: false,
      reason: 'corrupt-envelope',
      envelopeError: 'unsupported-version',
    });

    source.destroy();
    yjs1.destroyDoc?.(doc);
  });

  it('exposes the document tier: splice, observe, undo origins, anchors', () => {
    const doc = yjs1.createDoc();

    // observeText converts engine deltas into sequential splices.
    const batches: Array<{ edits: unknown; origin: unknown }> = [];
    const off = yjs1.observeText(doc, (edits, origin) => batches.push({ edits, origin }));
    yjs1.spliceText(doc, 0, 0, 'hello', 'me');
    yjs1.spliceText(doc, 2, 2, 'XY', 'me'); // replace 'll' with 'XY'
    expect(yjs1.getText(doc)).toBe('heXYo');
    expect(batches[0]).toEqual({ edits: [{ index: 0, deleteCount: 0, insert: 'hello' }], origin: 'me' });
    expect(batches[1]?.edits).toEqual([
      { index: 2, deleteCount: 2, insert: '' },
      { index: 2, deleteCount: 0, insert: 'XY' },
    ]);
    off();

    // Undo tracks only the named origins.
    const undo = yjs1.createUndo(doc, ['tracked']);
    yjs1.spliceText(doc, 0, 0, 'A-', 'tracked');
    yjs1.spliceText(doc, 0, 0, 'B-', 'untracked');
    expect(yjs1.getText(doc)).toBe('B-A-heXYo');
    undo.undo();
    expect(yjs1.getText(doc)).toBe('B-heXYo'); // only the tracked edit reverted
    expect(undo.canRedo()).toBe(true);
    undo.destroy();

    // Anchors survive edits before them.
    const anchor = yjs1.anchorAt(doc, 2, 0); // at 'h'
    yjs1.spliceText(doc, 0, 0, '>>', 'me');
    expect(yjs1.indexOfAnchor(doc, anchor)).toBe(4);
    yjs1.destroyDoc?.(doc);
  });
});
