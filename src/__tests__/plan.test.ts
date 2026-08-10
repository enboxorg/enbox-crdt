import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { decodeEnvelope } from '../envelope.js';
import { DEFAULT_SNAPSHOT_POLICY, encodeResidual, planFlush, shouldSnapshot } from '../plan.js';
import { yjs1 } from '../yjs1/index.js';

const freshState = () => ({
  lastFlushedStateVector: Y.encodeStateVector(new Y.Doc()),
  distinctDeltasSinceSnapshot: 0,
  lastSnapshotBytes: 0,
});

describe('planFlush', () => {
  it('plans noop when nothing changed beyond the flushed base', () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, 'settled');
    const state = {
      ...freshState(),
      lastFlushedStateVector: yjs1.encodeStateVector(doc),
    };
    expect(planFlush(yjs1, doc, state)).toEqual({ kind: 'noop' });
    yjs1.destroyDoc?.(doc);
  });

  it('plans an enveloped incremental residual for local changes', () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, 'hello');
    const flushedState = Y.encodeStateAsUpdate(doc); // what durable storage holds
    const flushedSv = yjs1.encodeStateVector(doc);
    doc.getText('content').insert(5, ' world');

    const plan = planFlush(yjs1, doc, { ...freshState(), lastFlushedStateVector: flushedSv });
    expect(plan.kind).toBe('incremental');
    if (plan.kind !== 'incremental') return;
    const { format, payload } = decodeEnvelope(plan.delta);
    expect(format).toBe('yjs1');

    // The payload is exactly the tail: flushed state + payload == full text.
    const remote = yjs1.createDoc();
    yjs1.applyDelta(remote, flushedState);
    expect(remote.getText('content').toString()).toBe('hello');
    yjs1.applyDelta(remote, payload);
    expect(remote.getText('content').toString()).toBe('hello world');
    yjs1.destroyDoc?.(doc);
    yjs1.destroyDoc?.(remote);
  });

  it('plans a full-state snapshot when the distinct-delta count trips the policy', () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, 'compact me');
    const plan = planFlush(yjs1, doc, {
      ...freshState(),
      distinctDeltasSinceSnapshot: DEFAULT_SNAPSHOT_POLICY.maxDeltasSinceSnapshot + 1,
    });
    expect(plan.kind).toBe('snapshot');
    if (plan.kind !== 'snapshot') return;
    const { format, payload } = decodeEnvelope(plan.delta);
    expect(format).toBe('yjs1');
    const rebuilt = yjs1.createDoc();
    yjs1.applyDelta(rebuilt, payload);
    expect(rebuilt.getText('content').toString()).toBe('compact me');
    yjs1.destroyDoc?.(doc);
    yjs1.destroyDoc?.(rebuilt);
  });

  it('accepts a Set for the distinct-delta count', () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, 'x');
    const over = new Set(Array.from({ length: DEFAULT_SNAPSHOT_POLICY.maxDeltasSinceSnapshot + 1 }, (_v, i) => `r${i}`));
    expect(shouldSnapshot(yjs1, doc, { distinctDeltasSinceSnapshot: over, lastSnapshotBytes: 0 })).toBe(true);
    yjs1.destroyDoc?.(doc);
  });

  it('canSnapshot: false forces the incremental residual even past thresholds', () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, 'editor session');
    const plan = planFlush(yjs1, doc, {
      ...freshState(),
      distinctDeltasSinceSnapshot: 1000,
      canSnapshot: false,
    });
    expect(plan.kind).toBe('incremental');
    yjs1.destroyDoc?.(doc);
  });

  it('byte-growth trigger honors the floor and the growth factor', () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, '0123456789'.repeat(20)); // ~200 bytes of state
    const bytes = yjs1.encodeFullState(doc).byteLength;

    // Floor suppresses byte-triggered snapshots for small documents…
    expect(
      shouldSnapshot(yjs1, doc, { distinctDeltasSinceSnapshot: 0, lastSnapshotBytes: 1 }),
    ).toBe(false);

    // …with a tiny floor, growth beyond factor × lastSnapshotBytes triggers…
    const policy = { maxDeltasSinceSnapshot: 64, byteGrowthFactor: 2, byteGrowthFloor: 0 };
    expect(
      shouldSnapshot(yjs1, doc, { distinctDeltasSinceSnapshot: 0, lastSnapshotBytes: Math.floor(bytes / 2) - 1 }, policy),
    ).toBe(true);

    // …but not while under factor × lastSnapshotBytes.
    expect(
      shouldSnapshot(yjs1, doc, { distinctDeltasSinceSnapshot: 0, lastSnapshotBytes: bytes }, policy),
    ).toBe(false);
    yjs1.destroyDoc?.(doc);
  });
});

describe('encodeResidual', () => {
  it('returns null when local and remote agree (even with deletions present)', () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, 'abc');
    doc.getText('content').delete(0, 1);
    expect(encodeResidual(yjs1, doc, yjs1.encodeStateVector(doc))).toBeNull();
    yjs1.destroyDoc?.(doc);
  });

  it('returns the enveloped tail beyond the remote state vector', () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, 'abc');
    const remoteSv = yjs1.encodeStateVector(doc);
    doc.getText('content').insert(3, 'def');
    const residual = encodeResidual(yjs1, doc, remoteSv);
    expect(residual).not.toBeNull();
    expect(decodeEnvelope(residual as Uint8Array).format).toBe('yjs1');
    yjs1.destroyDoc?.(doc);
  });
});
