/**
 * CollabDoc lifecycle tests. Deliberately contains NO `yjs` import — every
 * interaction goes through @enbox/crdt's own API, which is exactly the
 * guarantee consuming applications get.
 */

import { describe, expect, it, vi } from 'vitest';

import { encodeEnvelope } from '../index.js';
import type { TextChange } from '../index.js';
import { createYjs1Doc, unwrapYDoc } from '../yjs1/index.js';

const NO_BYTE_TRIGGER = 1 << 30;

describe('CollabDoc — editing and events', () => {
  it('edits text and reports local changes through the neutral event stream', () => {
    const doc = createYjs1Doc();
    const changes: TextChange[] = [];
    doc.onTextChange((change) => changes.push(change));

    doc.insertText(0, 'hello world');
    doc.replaceText(0, 5, 'goodbye');
    doc.deleteText(7, 6);

    expect(doc.getText()).toBe('goodbye');
    expect(changes.length).toBe(3);
    expect(changes.every((c) => c.source === 'local')).toBe(true);
    expect(changes[0]?.edits).toEqual([{ index: 0, deleteCount: 0, insert: 'hello world' }]);
    doc.destroy();
  });

  it('exposes the format id and the (escape-hatch) native document', () => {
    const doc = createYjs1Doc();
    expect(doc.format).toBe('yjs1');
    expect(unwrapYDoc(doc)).toBe(doc.unwrap());
    doc.destroy();
  });
});

describe('CollabDoc — flush lifecycle', () => {
  it('plans, commits, and settles to noop', () => {
    const doc = createYjs1Doc();
    expect(doc.hasUnflushedChanges()).toBe(false);

    doc.insertText(0, 'durable me');
    expect(doc.hasUnflushedChanges()).toBe(true);

    const plan = doc.planFlush();
    expect(plan.kind).toBe('incremental');
    if (plan.kind === 'noop') return;

    doc.commitFlush(plan, { recordId: 'r1' });
    expect(doc.hasUnflushedChanges()).toBe(false);
    expect(doc.planFlush()).toEqual({ kind: 'noop' });
    doc.destroy();
  });

  it('escalates to a snapshot when distinct durable deltas exceed the policy', () => {
    const doc = createYjs1Doc({
      snapshotPolicy: { maxDeltasSinceSnapshot: 2, byteGrowthFactor: 2, byteGrowthFloor: NO_BYTE_TRIGGER },
    });

    for (let i = 0; i < 3; i++) {
      doc.insertText(doc.getText().length, `chunk${i} `);
      const plan = doc.planFlush();
      expect(plan.kind).toBe('incremental');
      if (plan.kind !== 'noop') doc.commitFlush(plan, { recordId: `r${i}` });
    }

    // 3 distinct records > 2 — the next authorized flush compacts.
    doc.insertText(0, 'tip ');
    const snapshotPlan = doc.planFlush();
    expect(snapshotPlan.kind).toBe('snapshot');
    if (snapshotPlan.kind !== 'noop') doc.commitFlush(snapshotPlan, { recordId: 'squash-1' });

    // Counters reset: the following small change is incremental again.
    doc.insertText(0, 'more ');
    expect(doc.planFlush().kind).toBe('incremental');

    // Editors (no squash authority) never snapshot regardless of counters.
    expect(doc.planFlush({ canSnapshot: false }).kind).toBe('incremental');
    doc.destroy();
  });

  it('persists a deletion-only local edit, then settles without a write storm', () => {
    const doc = createYjs1Doc();
    doc.insertText(0, 'hello');
    const base = doc.planFlush();
    if (base.kind === 'noop') throw new Error('expected a base write');
    doc.commitFlush(base, { recordId: 'base' });

    doc.deleteText(0, 1);
    expect(doc.getText()).toBe('ello');
    expect(doc.hasUnflushedChanges()).toBe(true);
    const deletion = doc.planFlush();
    expect(deletion.kind).toBe('incremental');
    expect(doc.commitFlush(deletion, { recordId: 'delete' })).toEqual({ committed: true });

    expect(doc.hasUnflushedChanges()).toBe(false);
    expect(doc.planFlush()).toEqual({ kind: 'noop' });
    expect(doc.planRepublish()).toBeNull();
    doc.destroy();
  });
});

describe('CollabDoc — durable exchange between writers', () => {
  it('converges two documents through durable deltas and classifies sources', () => {
    const a = createYjs1Doc();
    const b = createYjs1Doc();
    const bChanges: TextChange[] = [];
    b.onTextChange((change) => bChanges.push(change));

    a.insertText(0, 'from A');
    const plan = a.planFlush();
    if (plan.kind === 'noop') throw new Error('expected a write');
    a.commitFlush(plan, { recordId: 'r1' });

    const outcome = b.applyDurable(plan.delta, { recordId: 'r1' });
    expect(outcome).toMatchObject({ applied: true, advanced: true });
    expect(b.getText()).toBe('from A');
    expect(bChanges.at(-1)?.source).toBe('durable');

    // A's own subscription echo is a no-op.
    expect(a.applyDurable(plan.delta, { recordId: 'r1' })).toMatchObject({ applied: true, advanced: false });
    a.destroy();
    b.destroy();
  });

  it('reports deletion-only durable and live frames as advancement', () => {
    const source = createYjs1Doc();
    const durable = createYjs1Doc();
    const live = createYjs1Doc();

    source.insertText(0, 'hello');
    const base = source.planFlush();
    if (base.kind === 'noop') throw new Error('expected a base write');
    source.commitFlush(base, { recordId: 'base' });
    durable.applyDurable(base.delta, { recordId: 'base' });
    live.applyDurable(base.delta, { recordId: 'base' });

    source.deleteText(0, 1);
    const deletion = source.planFlush();
    if (deletion.kind === 'noop') throw new Error('expected a deletion write');

    expect(durable.applyDurable(deletion.delta, { recordId: 'delete' }))
      .toMatchObject({ applied: true, advanced: true });
    expect(durable.applyDurable(deletion.delta, { recordId: 'delete' }))
      .toMatchObject({ applied: true, advanced: false });
    expect(durable.hasUnflushedChanges()).toBe(false);

    expect(live.applyLive(deletion.delta)).toMatchObject({ applied: true, advanced: true });
    expect(live.applyLive(deletion.delta)).toMatchObject({ applied: true, advanced: false });
    expect(live.hasUnflushedChanges()).toBe(true);

    source.destroy();
    durable.destroy();
    live.destroy();
  });

  it('survives the squash race: a foreign snapshot never destroys the local tail', () => {
    const snapshotEvery = { maxDeltasSinceSnapshot: 0, byteGrowthFactor: 0, byteGrowthFloor: 0 };
    const a = createYjs1Doc({ snapshotPolicy: snapshotEvery });
    const b = createYjs1Doc();

    // Shared base via A's first snapshot.
    a.insertText(0, 'shared base');
    const base = a.planFlush();
    if (base.kind !== 'snapshot') throw new Error('expected snapshot');
    const TS1 = '2026-08-10T10:00:00.000000Z';
    a.commitFlush(base, { recordId: 's1', messageTimestamp: TS1 });
    b.applyDurable(base.delta, { snapshot: true, messageTimestamp: TS1 });

    // B writes a local tail it has not flushed yet.
    b.insertText(b.getText().length, ' [B tail]');

    // A squashes again, never having seen B's tail.
    a.insertText(0, 'A2: ');
    const squash = a.planFlush();
    if (squash.kind !== 'snapshot') throw new Error('expected snapshot');
    const TS2 = '2026-08-10T11:00:00.000500Z';
    a.commitFlush(squash, { recordId: 's2', messageTimestamp: TS2 });

    // B applies the squash: its tail survives locally and shows as unflushed.
    b.applyDurable(squash.delta, { snapshot: true, messageTimestamp: TS2 });
    expect(b.getText()).toContain('[B tail]');
    expect(b.getText()).toContain('A2: ');
    expect(b.hasUnflushedChanges()).toBe(true);

    // The re-publish invariant, stamped strictly past the squash floor.
    const republish = b.planRepublish({
      afterSquashTs: TS2,
      nowMillis: Date.UTC(2026, 7, 10, 9, 0, 0, 0), // clock behind the squasher
    });
    expect(republish).not.toBeNull();
    expect(republish?.messageTimestamp).toBe('2026-08-10T11:00:00.000501Z');

    a.applyDurable(republish!.delta, { recordId: 'r-heal', messageTimestamp: republish!.messageTimestamp });
    expect(a.getText()).toBe(b.getText());
    a.destroy();
    b.destroy();
  });

  it('treats deltas stamped at or below the last snapshot as pruned (live-only)', () => {
    const a = createYjs1Doc({ snapshotPolicy: { maxDeltasSinceSnapshot: 0, byteGrowthFactor: 2, byteGrowthFloor: 0 } });
    const b = createYjs1Doc();
    const c = createYjs1Doc();

    a.insertText(0, 'base');
    const base = a.planFlush();
    if (base.kind === 'noop') throw new Error('expected write');
    const TS1 = '2026-08-10T10:00:00.000000Z';

    // C wrote a delta before the squash existed…
    c.applyDurable(base.delta, { recordId: 's1' });
    c.insertText(4, ' +C');
    const cPlan = c.planFlush({ canSnapshot: false });
    if (cPlan.kind === 'noop') throw new Error('expected write');

    // …B first learns of the snapshot (which omits C's op)…
    const TS2 = '2026-08-10T11:00:00.000000Z';
    b.applyDurable(base.delta, { snapshot: true, messageTimestamp: TS2 });
    expect(b.hasUnflushedChanges()).toBe(false);

    // …then C's older delta arrives late. Storage pruned it at the squash, so
    // it must NOT count as durable — but its content must not be lost either.
    b.applyDurable(cPlan.delta, { recordId: 'rc', messageTimestamp: TS1 });
    expect(b.getText()).toBe('base +C');
    expect(b.hasUnflushedChanges()).toBe(true); // B will re-publish C's op
    expect(b.planFlush({ canSnapshot: false }).kind).toBe('incremental');
    a.destroy();
    b.destroy();
    c.destroy();
  });

  it('keeps the newest snapshot floor when an older snapshot arrives late', () => {
    const base = createYjs1Doc();
    base.insertText(0, 'base');
    const snapshot = base.encodeFullState();

    const delayedWriter = createYjs1Doc();
    delayedWriter.applyDurable(snapshot, { snapshot: true });
    delayedWriter.insertText(4, ' delayed');
    const delayed = delayedWriter.planFlush({ canSnapshot: false });
    if (delayed.kind === 'noop') throw new Error('expected a delayed delta');

    const doc = createYjs1Doc();
    doc.applyDurable(snapshot, {
      snapshot: true,
      messageTimestamp: '2026-08-10T12:00:00.000000Z',
    });
    doc.applyDurable(snapshot, {
      snapshot: true,
      messageTimestamp: '2026-08-10T10:00:00.000000Z',
    });
    doc.applyDurable(delayed.delta, {
      recordId: 'already-pruned',
      messageTimestamp: '2026-08-10T11:00:00.000000Z',
    });

    expect(doc.getText()).toBe('base delayed');
    expect(doc.hasUnflushedChanges()).toBe(true);
    base.destroy();
    delayedWriter.destroy();
    doc.destroy();
  });

  it('rejects a stale acknowledgement and commits the fresh re-publish explicitly', () => {
    const base = createYjs1Doc();
    base.insertText(0, 'base');
    const initial = base.encodeFullState();

    const doc = createYjs1Doc();
    doc.applyDurable(initial, {
      snapshot: true,
      messageTimestamp: '2026-08-10T10:00:00.000000Z',
    });
    doc.insertText(4, ' local');
    const inFlight = doc.planFlush({ canSnapshot: false });
    if (inFlight.kind === 'noop') throw new Error('expected an in-flight write');

    const squasher = createYjs1Doc();
    squasher.applyDurable(initial, { snapshot: true });
    squasher.insertText(0, 'new ');
    doc.applyDurable(squasher.encodeFullState(), {
      snapshot: true,
      messageTimestamp: '2026-08-10T12:00:00.000000Z',
    });

    expect(doc.commitFlush(inFlight, {
      recordId: 'purged-before-ack',
      messageTimestamp: '2026-08-10T11:00:00.000000Z',
    })).toEqual({
      committed: false,
      reason: 'superseded',
      squashFloorTimestamp: '2026-08-10T12:00:00.000000Z',
    });
    expect(doc.hasUnflushedChanges()).toBe(true);

    const republish = doc.planRepublish({
      afterSquashTs: '2026-08-10T12:00:00.000000Z',
      nowMillis: Date.UTC(2026, 7, 10, 11, 0, 0),
    });
    expect(republish).not.toBeNull();
    expect(doc.commitRepublish(republish!, { recordId: 'fresh' })).toEqual({ committed: true });
    expect(doc.hasUnflushedChanges()).toBe(false);

    base.destroy();
    squasher.destroy();
    doc.destroy();
  });

  it('fails closed on foreign formats and raw legacy bytes without touching the text', () => {
    const doc = createYjs1Doc();
    doc.insertText(0, 'safe');

    const foreign = doc.encodeFullState();
    expect(doc.applyDurable(encodeEnvelope('loro1', Uint8Array.from([1, 2, 3])))).toMatchObject({
      applied: false,
      reason: 'format-mismatch',
      format: 'loro1',
    });
    expect(doc.applyDurable(Uint8Array.from([9, 9, 9]))).toMatchObject({ applied: false, reason: 'not-an-envelope' });
    expect(doc.getText()).toBe('safe');
    expect(foreign.byteLength).toBeGreaterThan(0);
    doc.destroy();
  });
});

describe('CollabDoc — realtime', () => {
  it('broadcasts local edits (and only local edits) as enveloped frames', () => {
    const a = createYjs1Doc();
    const b = createYjs1Doc();
    const frames: Uint8Array[] = [];
    a.onLocalUpdate((frame) => frames.push(frame));

    a.insertText(0, 'typed live');
    expect(frames.length).toBe(1);

    for (const frame of frames) b.applyLive(frame);
    expect(b.getText()).toBe('typed live');
    expect(b.hasUnflushedChanges()).toBe(true); // live is never the durability owner

    // Inbound application must not echo back out.
    const before = frames.length;
    a.applyLive(b.encodeFullState());
    a.applyDurable(b.encodeFullState());
    expect(frames.length).toBe(before);
    a.destroy();
    b.destroy();
  });

  it('heals a behind peer via connectLiveSync probes', () => {
    const a = createYjs1Doc();
    const b = createYjs1Doc();
    a.insertText(0, 'already here');

    // A minimal two-party room: each side's probe reaches the other's onSync;
    // heal frames are delivered to the other side's applyLive (app glue).
    const aSync = new Set<(f: Uint8Array) => void>();
    const bSync = new Set<(f: Uint8Array) => void>();
    const channelFor = (
      mineSync: Set<(f: Uint8Array) => void>,
      theirsSync: Set<(f: Uint8Array) => void>,
      deliverHeal: (f: Uint8Array) => void,
    ) => ({
      broadcastSync: (frame: Uint8Array) => {
        for (const h of theirsSync) h(frame);
      },
      onSync: (handler: (frame: Uint8Array) => void) => {
        mineSync.add(handler);
        return () => mineSync.delete(handler);
      },
      broadcastHeal: (frame: Uint8Array) => deliverHeal(frame),
    });

    const offA = a.connectLiveSync(channelFor(aSync, bSync, (f) => b.applyLive(f)), { intervalMs: 60_000 });
    const offB = b.connectLiveSync(channelFor(bSync, aSync, (f) => a.applyLive(f)), { intervalMs: 60_000 });

    // B's connect-time probe reached A, which healed B immediately.
    expect(b.getText()).toBe('already here');
    offA();
    offB();
    a.destroy();
    b.destroy();
  });
});

describe('CollabDoc — undo and anchors', () => {
  it('undoes only local edits, never peer changes', () => {
    const a = createYjs1Doc();
    const b = createYjs1Doc();

    a.insertText(0, 'peer content. ');
    const plan = a.planFlush();
    if (plan.kind === 'noop') throw new Error('expected write');
    b.applyDurable(plan.delta, { recordId: 'r1' });

    expect(b.canUndo()).toBe(false);
    b.insertText(b.getText().length, 'mine');
    expect(b.canUndo()).toBe(true);

    b.undo();
    expect(b.getText()).toBe('peer content. ');
    expect(b.canRedo()).toBe(true);
    b.redo();
    expect(b.getText()).toBe('peer content. mine');
    a.destroy();
    b.destroy();
  });

  it('anchors survive concurrent edits and travel between peers', () => {
    const a = createYjs1Doc();
    const b = createYjs1Doc();

    a.insertText(0, 'hello world');
    const sync = () => {
      const plan = a.planFlush();
      if (plan.kind !== 'noop') {
        a.commitFlush(plan, { recordId: `r${Math.trunc(a.getText().length)}` });
        b.applyDurable(plan.delta);
      }
    };
    sync();

    const anchor = a.anchorAt(6); // before 'w'
    expect(a.indexOfAnchor(anchor)).toBe(6);

    // A prepends — the anchor keeps pointing at 'w' on BOTH sides.
    a.insertText(0, '>> ');
    sync();
    expect(a.indexOfAnchor(anchor)).toBe(9);
    expect(b.indexOfAnchor(anchor)).toBe(9);
    expect(b.getText()[b.indexOfAnchor(anchor) as number]).toBe('w');
    a.destroy();
    b.destroy();
  });
});

describe('CollabDoc — lifecycle', () => {
  it('round-trips a full-state export into a fresh document', () => {
    const a = createYjs1Doc();
    a.insertText(0, 'export me');
    const b = createYjs1Doc();
    b.applyDurable(a.encodeFullState(), { snapshot: true });
    expect(b.getText()).toBe('export me');
    a.destroy();
    b.destroy();
  });

  it('destroy is idempotent and use-after-destroy throws', () => {
    const doc = createYjs1Doc();
    doc.insertText(0, 'bye');
    doc.destroy();
    doc.destroy();
    expect(() => doc.getText()).toThrow(/destroyed/);
    expect(() => doc.insertText(0, 'x')).toThrow(/destroyed/);
    expect(() => doc.planFlush()).toThrow(/destroyed/);
  });

  it('makes subscription teardowns idempotent before and after destroy', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const doc = createYjs1Doc();
      const offText = doc.onTextChange(() => undefined);
      const offUpdate = doc.onLocalUpdate(() => undefined);
      let syncUnsubscribeCount = 0;
      const offSync = doc.connectLiveSync({
        broadcastSync: () => undefined,
        broadcastHeal: () => undefined,
        onSync: () => () => {
          syncUnsubscribeCount++;
        },
      }, { intervalMs: 60_000 });

      offText();
      offText();
      doc.destroy();
      offText();
      offUpdate();
      offUpdate();
      offSync();
      offSync();

      expect(syncUnsubscribeCount).toBe(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
