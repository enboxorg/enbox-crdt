/**
 * DurableWriter tests (v3 Unit 3b) — the stateful flush loop driven entirely through
 * injected timers + a mocked `create`, proving the convergence/correctness
 * properties from the plan:
 *  - idle debounce coalesces; 30s sustained-typing backstop fires;
 *  - snapshot trigger after >64 distinct delta ids; counters reset;
 *  - backstop (409) → ONE forward-stamped re-publish; no tight loop on a second 409;
 *  - page-gone (400 ParentNotFound) → teardown once; subsequent calls no-op;
 *  - transient error → ops retained, re-published on next convergence;
 *  - convergence re-publish only on non-null residual; suppressed when a flush is
 *    pending; own-echo does NOT arm the timer;
 *  - N-writer burst → bounded (single) re-publish after settle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SNAPSHOT_POLICY } from '../plan.js';
import { createYjs1Doc } from '../yjs1/index.js';
import {
  DurableWriter, type DurableWriterClock, type DurableWriterOptions,
  type DurableWriteRequest, type DurableWriteRecord,
} from '../enbox/index.js';

type TestDocument = ReturnType<typeof createYjs1Doc>;
type TestWriteResult = DurableWriteRecord | Error;
const TEST_TIMERS = { idleMs: 2000, backstopMs: 30000, convergenceMs: 1000 };
const FAST_TIMERS = { idleMs: 600, backstopMs: 5000, convergenceMs: 500 };

function documentFromDeltas(deltas: readonly { recordId: string; data: Uint8Array }[]): TestDocument {
  const doc = createYjs1Doc();
  for (const delta of deltas) doc.applyDurable(delta.data, { recordId: delta.recordId });
  return doc;
}

// ---------------------------------------------------------------------------
// A deterministic fake clock with manual timer advancement.
// ---------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
}

function makeClock(startMs = 1_700_000_000_000): DurableWriterClock & {
  advance(ms: number): void;
  current(): number;
  pending(): number;
} {
  let nowMs = startMs;
  let seq = 0;
  const timers = new Map<number, FakeTimer>();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { id, fireAt: nowMs + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle === 'number') timers.delete(handle);
    },
    now() {
      return nowMs;
    },
    advance(ms) {
      const target = nowMs + ms;
      // Fire due timers in chronological order; allow timers armed during firing.
      for (;;) {
        let next: FakeTimer | undefined;
        for (const t of timers.values()) {
          if (t.fireAt <= target && (!next || t.fireAt < next.fireAt)) next = t;
        }
        if (!next) break;
        timers.delete(next.id);
        nowMs = next.fireAt;
        next.fn();
      }
      nowMs = target;
    },
    current() {
      return nowMs;
    },
    pending() {
      return timers.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Write-result builders.
// ---------------------------------------------------------------------------

let recSeq = 0;
function okResult(): DurableWriteRecord {
  const sequence = ++recSeq;
  return { id: `rec-${sequence}`, timestamp: `2026-01-01T00:00:00.${String(sequence).padStart(6, '0')}Z` };
}
function backstop(floor = '2026-02-02T00:00:00.000000Z'): Error {
  return Object.assign(new Error('Squash backstop'), { status: {
    code: 409, errorCode: 'ProtocolAuthorizationSquashBackstop', info: { squashFloorTimestamp: floor },
  } });
}
function pageGone(): Error {
  return Object.assign(new Error('Parent gone'), { status: {
    code: 400, errorCode: 'ProtocolAuthorizationParentRecordNotFound',
  } });
}
function transient(): Error {
  return Object.assign(new Error('Service Unavailable'), { status: { code: 503, detail: 'Service Unavailable' } });
}

// ---------------------------------------------------------------------------
// Loop construction harness.
// ---------------------------------------------------------------------------

interface Harness {
  loop: DurableWriter;
  doc: TestDocument;
  clock: ReturnType<typeof makeClock>;
  create: ReturnType<typeof vi.fn>;
  onParentGone: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  /** The args of every create call. */
  writes(): DurableWriteRequest[];
}

function makeLoop(
  over: Partial<DurableWriterOptions> & {
    writeImpl?: (args: DurableWriteRequest) => Promise<TestWriteResult> | TestWriteResult;
  } = {},
): Harness {
  const doc = documentFromDeltas([]);
  const clock = makeClock();
  const writeImpl = over.writeImpl ?? (() => okResult());
  const create = vi.fn(async (args: DurableWriteRequest) => {
    const result = await writeImpl(args);
    if (result instanceof Error) throw result;
    return args.messageTimestamp !== undefined ? { ...result, timestamp: args.messageTimestamp } : result;
  });
  const onParentGone = vi.fn();
  const onError = vi.fn();

  const loop = new DurableWriter({
    timers: TEST_TIMERS,
    doc,
    create,
    onParentGone,
    onError,
    clock,
    ...over,
  });

  return {
    loop,
    doc,
    clock,
    create,
    onParentGone,
    onError,
    writes: () => create.mock.calls.map((c) => c[0] as DurableWriteRequest),
  };
}

/** Type one string into the doc's content (a local change). */
function type(doc: TestDocument, text: string): void {
  doc.insertText(doc.getText().length, text);
}

/** Build a raw update for `text` from a separate collaborative document. */
function remoteUpdate(text: string, base?: Uint8Array): { update: Uint8Array; doc: TestDocument } {
  const doc = documentFromDeltas(base === undefined
    ? []
    : [{ recordId: 'base', data: base }]);
  doc.insertText(doc.getText().length, text);
  return { update: doc.encodeFullState(), doc };
}

/** Materialize raw Notesd v1 updates through the neutral document boundary. */
function mergeText(updates: readonly Uint8Array[]): string {
  const doc = documentFromDeltas(updates.map((data, index) => ({
    recordId: `update-${index}`,
    data,
  })));
  try {
    return doc.getText();
  } finally {
    doc.destroy();
  }
}

beforeEach(() => {
  recSeq = 0;
});

// ---------------------------------------------------------------------------
// Idle debounce + backstop
// ---------------------------------------------------------------------------

describe('DurableWriter — local-change triggers', () => {
  it('coalesces rapid onLocalChange into ONE idle flush with the final residual', async () => {
    const h = makeLoop();
    type(h.doc, 'a');
    h.loop.onLocalChange();
    h.clock.advance(500);
    type(h.doc, 'b');
    h.loop.onLocalChange();
    h.clock.advance(500);
    type(h.doc, 'c');
    h.loop.onLocalChange();

    // Not yet idle for 2s since the last change.
    h.clock.advance(1999);
    expect(h.create).not.toHaveBeenCalled();

    h.clock.advance(1); // now 2000ms idle
    await Promise.resolve();

    expect(h.create).toHaveBeenCalledTimes(1);
    // The single flush carries the full residual (a+b+c).
    expect(mergeText([h.writes()[0]!.data])).toBe('abc');
  });

  it('fires the 30s backstop during sustained typing (idle never reached)', async () => {
    const h = makeLoop();
    // Type every 1s for 30s — idle (2s) never elapses, but the backstop must fire.
    for (let i = 0; i < 30; i++) {
      type(h.doc, 'x');
      h.loop.onLocalChange();
      h.clock.advance(1000);
    }
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.writes()[0]!.squash).toBeUndefined();
    expect(Object.keys(h.writes()[0]!)).toEqual(['data']);
  });
});

// ---------------------------------------------------------------------------
// Snapshot path
// ---------------------------------------------------------------------------

describe('DurableWriter — snapshot trigger (KTD-4)', () => {
  it('snapshots after >64 distinct delta ids, then resets counters', async () => {
    const h = makeLoop();
    // Drive flushes until the distinct-id count EXCEEDS the threshold. The plan
    // is computed BEFORE the write (count reflects prior flushes), so the snapshot
    // lands on the flush AFTER the count crosses the threshold.
    for (let i = 0; i <= DEFAULT_SNAPSHOT_POLICY.maxDeltasSinceSnapshot + 1; i++) {
      type(h.doc, 'y');
      await h.loop.flush();
    }
    const calls = h.writes();
    // The first SNAPSHOT_DELTA_THRESHOLD+1 writes are incremental; once the
    // distinct-id count EXCEEDS the threshold, the next flush snapshots.
    const snapIndex = calls.findIndex((c) => c.squash);
    expect(snapIndex).toBeGreaterThan(0);
    expect(calls[snapIndex]!.squash).toBe(true);
    expect(Object.keys(calls[snapIndex]!)).toEqual(['data', 'squash']);

    // After the snapshot, the counter reset — the immediately following flush is
    // incremental again (not another snapshot).
    type(h.doc, 'z');
    await h.loop.flush();
    expect(h.writes().at(-1)!.squash).toBeUndefined();
  });

  it('keeps an editor on incremental writes after the snapshot threshold', async () => {
    const h = makeLoop({ canSquash: false });
    for (let i = 0; i <= DEFAULT_SNAPSHOT_POLICY.maxDeltasSinceSnapshot + 2; i++) {
      type(h.doc, 'e');
      await h.loop.flush();
    }
    expect(h.writes()).not.toContainEqual(expect.objectContaining({ squash: true }));
    expect(h.writes()).toHaveLength(DEFAULT_SNAPSHOT_POLICY.maxDeltasSinceSnapshot + 3);
  });

  it('forward-stamps an older delta arriving after a local snapshot ack but before its echo', async () => {
    const snapshotTimestamp = '2026-02-02T00:00:00.000000Z';
    let sequence = 0;
    const h = makeLoop({
      writeImpl: (args) => ({
        id        : `record-${++sequence}`,
        timestamp : args.squash
          ? snapshotTimestamp
          : `2026-01-01T00:00:00.${String(sequence).padStart(6, '0')}Z`,
      }),
    });

    for (let i = 0; i <= DEFAULT_SNAPSHOT_POLICY.maxDeltasSinceSnapshot + 1; i++) {
      type(h.doc, 's');
      await h.loop.flush();
    }
    const snapshot = h.writes().at(-1)!;
    expect(snapshot.squash).toBe(true);
    h.create.mockClear();

    const delayed = remoteUpdate('delayed pre-snapshot edit');
    h.loop.applyDurable(delayed.update, { recordId: 'older-delta',
      messageTimestamp: '2026-02-01T23:59:59.999999Z',
    });
    h.clock.advance(TEST_TIMERS.convergenceMs);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.create).toHaveBeenCalledOnce();
    const healing = h.writes()[0]!;
    expect(healing.messageTimestamp! > snapshotTimestamp).toBe(true);

    expect(mergeText([snapshot.data, healing.data])).toContain('delayed pre-snapshot edit');
    delayed.doc.destroy();
  });
});

// ---------------------------------------------------------------------------
// Backstop (KTD-2/3)
// ---------------------------------------------------------------------------

describe('DurableWriter — squash backstop (KTD-2/3)', () => {
  it('on a 409 backstop, re-publishes EXACTLY once with a forward-stamped timestamp', async () => {
    const squashTs = '2026-02-02T00:00:00.000000Z';
    let call = 0;
    const h = makeLoop({
      writeImpl: () => (++call === 1 ? backstop(squashTs) : okResult()),
    });
    type(h.doc, 'offline-edit');
    await h.loop.flush();
    await Promise.resolve();

    // First write (rejected) + exactly one re-publish.
    expect(h.create).toHaveBeenCalledTimes(2);
    const republish = h.writes()[1]!;
    // Forward-stamped strictly past the squash timestamp (clock-skew safe).
    expect(republish.messageTimestamp).toBeDefined();
    expect(republish.messageTimestamp! > squashTs).toBe(true);
    expect(republish.dateCreated).toBe(republish.messageTimestamp);
    // The re-published bytes still carry the offline edit.
    expect(mergeText([republish.data])).toBe('offline-edit');
  });

  it('does NOT tight-loop when the re-publish ALSO backstops (defers to convergence)', async () => {
    const h = makeLoop({ writeImpl: () => backstop() }); // every write 409s
    type(h.doc, 'edit');
    await h.loop.flush();
    await Promise.resolve();

    // Original write + exactly ONE immediate re-publish — no third immediate attempt.
    expect(h.create).toHaveBeenCalledTimes(2);

    // No tight loop: advancing time without any new convergence event triggers
    // no further writes (the retry is scheduled, not spun).
    h.clock.advance(10_000);
    await Promise.resolve();
    // Only the scheduled convergence timer (if armed) may fire once more, never a loop.
    expect(h.create.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('treats a backstopped write as durable when an arriving squash already contains it', async () => {
    let resolveWrite!: (result: TestWriteResult) => void;
    const pendingWrite = new Promise<TestWriteResult>((resolve) => { resolveWrite = resolve; });
    const h = makeLoop({ writeImpl: () => pendingWrite });
    type(h.doc, 'already merged');

    const flushing = h.loop.flush();
    await Promise.resolve();
    const squash = h.doc.encodeFullState();
    h.loop.applyDurable(squash, { recordId: 'squash',
      snapshot: true,
      messageTimestamp: '2026-02-02T00:00:00.000000Z',
    });
    const draining = h.loop.drain();
    resolveWrite(backstop());

    await expect(Promise.all([flushing, draining])).resolves.toBeDefined();
    expect(h.create).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Page-gone (KTD-2 terminal)
// ---------------------------------------------------------------------------

describe('DurableWriter — page-gone teardown (KTD-2)', () => {
  it('invokes teardown once, cancels timers, and no-ops afterward', async () => {
    const h = makeLoop({ writeImpl: () => pageGone() });
    type(h.doc, 'edit');
    await h.loop.flush();
    await Promise.resolve();

    expect(h.onParentGone).toHaveBeenCalledTimes(1);
    expect(h.onParentGone).toHaveBeenCalledWith();
    expect(h.loop.isDisposed).toBe(true);

    // Never re-publishes a page-gone delta — exactly the one rejected write.
    expect(h.create).toHaveBeenCalledTimes(1);

    // Subsequent local changes are no-ops (no timers armed, no flush).
    type(h.doc, 'more');
    h.loop.onLocalChange();
    h.clock.advance(60_000);
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.clock.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Transient error
// ---------------------------------------------------------------------------

describe('DurableWriter — transient error', () => {
  it('retains ops on a transient write error (next flush carries them)', async () => {
    let call = 0;
    const h = makeLoop({
      writeImpl: () => (++call === 1 ? transient() : okResult()),
    });
    type(h.doc, 'one');
    await h.loop.flush();
    await Promise.resolve();
    expect(h.onError).toHaveBeenCalledTimes(1);

    // The ops were retained: the NEXT flush still carries 'one' (plus 'two').
    type(h.doc, 'two');
    await h.loop.flush();
    expect(mergeText([h.writes().at(-1)!.data])).toBe('onetwo');
  });
});

// ---------------------------------------------------------------------------
// Strict lifecycle drain
// ---------------------------------------------------------------------------

describe('DurableWriter — strict drain', () => {
  it('rejects with the non-ok delta status instead of treating it as persisted', async () => {
    const failure = transient();
    const h = makeLoop({ writeImpl: () => failure });
    type(h.doc, 'unsaved');

    await expect(h.loop.drain()).rejects.toBe(failure);

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledWith(failure);
  });

  it('joins an in-flight flush and writes edits created while that write was pending', async () => {
    let resolveFirst!: (result: TestWriteResult) => void;
    const firstResult = new Promise<TestWriteResult>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    const h = makeLoop({
      writeImpl: () => (++call === 1 ? firstResult : okResult()),
    });

    type(h.doc, 'first');
    const initialFlush = h.loop.flush();
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledTimes(1);

    // This edit is not in the first write's plan-time state vector.
    type(h.doc, ' second');
    h.loop.onLocalChange();
    const drain = h.loop.drain();
    resolveFirst(okResult());

    await Promise.all([initialFlush, drain]);

    expect(h.create).toHaveBeenCalledTimes(2);
    expect(mergeText(h.writes().map((write) => write.data))).toBe('first second');
  });

  it('makes a concurrent flush join an in-flight write and persist its call-time state', async () => {
    let resolveFirst!: (result: TestWriteResult) => void;
    const firstResult = new Promise<TestWriteResult>((resolve) => { resolveFirst = resolve; });
    let call = 0;
    const h = makeLoop({
      writeImpl: () => (++call === 1 ? firstResult : okResult()),
    });

    type(h.doc, 'first');
    const first = h.loop.flush();
    await Promise.resolve();
    type(h.doc, ' second');
    const barrier = h.loop.flush();
    let barrierDone = false;
    void barrier.then(() => { barrierDone = true; });
    await Promise.resolve();
    expect(barrierDone).toBe(false);

    resolveFirst(okResult());
    await Promise.all([first, barrier]);

    expect(h.create).toHaveBeenCalledTimes(2);
    expect(mergeText(h.writes().map((write) => write.data))).toBe('first second');
  });

  it('drains edits made while republishNow is in flight without overlapping writes', async () => {
    let resolveFirst!: (result: TestWriteResult) => void;
    const firstResult = new Promise<TestWriteResult>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    const h = makeLoop({
      writeImpl: () => (++call === 1 ? firstResult : okResult()),
    });

    type(h.doc, 'first');
    const republish = h.loop.republishNow();
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledOnce();

    type(h.doc, ' second');
    h.loop.onLocalChange();
    const drain = h.loop.drain();
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledOnce();

    resolveFirst(okResult());
    await expect(republish).resolves.toBe(true);
    await drain;

    expect(h.create).toHaveBeenCalledTimes(2);
    expect(mergeText(h.writes().map((write) => write.data))).toBe('first second');
    expect(h.clock.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Convergence re-publish (KTD-3)
// ---------------------------------------------------------------------------

describe('DurableWriter — convergence re-publish (KTD-3)', () => {
  it("reconstructs the durable shadow on squash and republishes an editor's purged ack", async () => {
    const squashTs = '2026-02-02T00:00:00.000000Z';
    const h = makeLoop();
    type(h.doc, 'editor ack');
    await h.loop.flush();
    const purgedAck = h.writes()[0]!.data;
    h.create.mockClear();

    // Another admin compacted from a local state that never received the
    // editor's acknowledged update. The server now contains ONLY this snapshot.
    const squasher = remoteUpdate('admin snapshot');
    const snapshot = squasher.update;
    h.loop.applyDurable(snapshot, { recordId: 'squash-rec',
      snapshot: true,
      messageTimestamp: squashTs,
    });
    // Decryption/routing is asynchronous, so an echo for a record purged by the
    // squash may complete afterward. It must not be added back to the shadow.
    h.loop.applyDurable(purgedAck, { recordId: 'purged-echo',
      messageTimestamp: '2026-02-01T00:00:00.000000Z',
    });
    h.clock.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.create).toHaveBeenCalledOnce();
    const healing = h.writes()[0]!;
    expect(healing.squash).toBeUndefined();
    expect(healing.messageTimestamp! > squashTs).toBe(true);

    // Recreate the post-squash server: snapshot + healing delta. Both editors'
    // text must survive even though the older acknowledged record was purged.
    const text = mergeText([snapshot, healing.data]);
    expect(text).toContain('editor ack');
    expect(text).toContain('admin snapshot');
    squasher.doc.destroy();
  });

  it('normal flush after a squash uses the replacement shadow as its delta base', async () => {
    const h = makeLoop();
    type(h.doc, 'acked edit');
    await h.loop.flush();
    h.create.mockClear();

    type(h.doc, ' and pending edit');
    h.loop.onLocalChange();
    const squasher = remoteUpdate('admin snapshot');
    const snapshot = squasher.update;
    h.loop.applyDurable(snapshot, { recordId: 'squash-rec',
      snapshot: true,
      messageTimestamp: '2026-02-02T00:00:00.000000Z',
    });

    // The convergence timer is suppressed by the pending ordinary flush.
    h.clock.advance(1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.create).not.toHaveBeenCalled();
    h.clock.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.create).toHaveBeenCalledOnce();
    expect(mergeText([snapshot, h.writes()[0]!.data])).toContain('acked edit and pending edit');
    squasher.doc.destroy();
  });

  it('does not re-add a purged write when its success response arrives after the squash', async () => {
    let resolveOldWrite!: (result: TestWriteResult) => void;
    const oldWrite = new Promise<TestWriteResult>((resolve) => { resolveOldWrite = resolve; });
    let call = 0;
    const h = makeLoop({
      writeImpl: () => ++call === 1
        ? oldWrite
        : {
            id: 'healing-delta',
            timestamp: '2026-02-02T00:00:00.000001Z',
          },
    });
    type(h.doc, 'editor write');
    const flushing = h.loop.flush();
    await Promise.resolve();

    const squasher = remoteUpdate('admin snapshot');
    const snapshot = squasher.update;
    h.loop.applyDurable(snapshot, { recordId: 'squash-rec',
      snapshot: true,
      messageTimestamp: '2026-02-02T00:00:00.000000Z',
    });
    resolveOldWrite({
      id: 'already-purged',
      timestamp: '2026-02-01T23:59:59.999999Z',
    });
    await flushing;

    expect(h.create).toHaveBeenCalledTimes(2);
    const text = mergeText([snapshot, h.writes()[1]!.data]);
    expect(text).toContain('editor write');
    expect(text).toContain('admin snapshot');
    squasher.doc.destroy();
  });

  it('forward-stamps a purged delta event that decrypts after the squash has settled', async () => {
    const floor = '2026-02-02T00:00:00.000000Z';
    const h = makeLoop();
    const squasher = remoteUpdate('admin snapshot');
    h.loop.applyDurable(squasher.update, { recordId: 'squash-rec',
      snapshot: true,
      messageTimestamp: floor,
    });
    h.clock.advance(1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.create).not.toHaveBeenCalled();

    const delayed = remoteUpdate('purged editor edit');
    h.loop.applyDurable(delayed.update, { recordId: 'purged-rec',
      messageTimestamp: '2026-02-01T23:59:59.999999Z',
    });
    h.clock.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.create).toHaveBeenCalledOnce();
    expect(h.writes()[0]!.messageTimestamp! > floor).toBe(true);
    expect(mergeText([squasher.update, h.writes()[0]!.data])).toContain('purged editor edit');
    delayed.doc.destroy();
    squasher.doc.destroy();
  });

  it('re-publishes a non-null residual after a remote delta settles', async () => {
    const h = makeLoop();
    // Local has an op the remote-known state lacks.
    type(h.doc, 'local');
    // A remote delta from another writer arrives (advances the doc).
    const { update } = remoteUpdate('remote');
    h.loop.applyDurable(update, { recordId: 'remote-rec',});

    // Trailing convergence timer (1s) not yet fired.
    expect(h.create).not.toHaveBeenCalled();
    h.clock.advance(1000);
    await Promise.resolve();

    // One re-publish carrying the local residual (which the server-known SV lacks).
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.writes()[0]!.squash).toBeUndefined();

    await h.loop.flush();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('serializes a local flush behind an in-flight convergence re-publish', async () => {
    let resolveFirst!: (result: TestWriteResult) => void;
    const firstResult = new Promise<TestWriteResult>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    const h = makeLoop({
      writeImpl: () => (++call === 1 ? firstResult : okResult()),
    });
    type(h.doc, 'local');
    const remote = remoteUpdate('remote');
    h.loop.applyDurable(remote.update, { recordId: 'remote-rec',});

    h.clock.advance(TEST_TIMERS.convergenceMs);
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledOnce();

    type(h.doc, ' later');
    const flushing = h.loop.flush();
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledOnce();

    resolveFirst(okResult());
    await flushing;

    expect(h.create).toHaveBeenCalledTimes(2);
    const durableText = mergeText([
      remote.update,
      ...h.writes().map((write) => write.data),
    ]);
    expect(durableText).toContain('remote');
    expect(durableText).toContain('local');
    expect(durableText).toContain('later');
    remote.doc.destroy();
  });

  it('does not arm convergence when an own echo reports no advance', async () => {
    const h = makeLoop();
    type(h.doc, 'mine');
    await h.loop.flush(); // writes + advances the shadow (acked)
    h.create.mockClear();

    // Echo our own just-written delta back via the subscription path.
    const echo = h.doc.encodeFullState();
    h.loop.applyDurable(echo, { recordId: 'echo-rec',});
    h.clock.advance(5000);
    await Promise.resolve();

    // No re-publish — the echo did not change the doc, no timer armed.
    expect(h.create).not.toHaveBeenCalled();
  });

  it('suppresses the convergence re-publish when a normal flush is pending', async () => {
    const h = makeLoop();
    type(h.doc, 'local');
    h.loop.onLocalChange(); // arms a pending flush (idle 2s)

    const { update } = remoteUpdate('remote');
    h.loop.applyDurable(update, { recordId: 'remote-rec',});
    // Convergence timer fires at 1s — but a flush is pending, so it suppresses.
    h.clock.advance(1000);
    await Promise.resolve();
    expect(h.create).not.toHaveBeenCalled();

    // The pending idle flush fires at 2s and carries the residual itself.
    h.clock.advance(1000);
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('does not re-publish when local and remote already agree (no write storm)', async () => {
    const h = makeLoop();
    // A remote delta arrives that the local doc does NOT yet have; after applying
    // it, the local doc == remote-known, so the residual is empty.
    const { update } = remoteUpdate('only-remote');
    h.loop.applyDurable(update, { recordId: 'remote-rec',});
    h.clock.advance(1000);
    await Promise.resolve();
    expect(h.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// N-writer bound
// ---------------------------------------------------------------------------

describe('DurableWriter — N-writer convergence bound (no storm)', () => {
  it('a burst of 3 writers yields a single re-publish after settle, not per-event', async () => {
    const h = makeLoop();
    type(h.doc, 'mine'); // local residual the server-known SV lacks

    // Three remote writers' deltas arrive in a tight burst (each advances the doc).
    const a = remoteUpdate('A');
    h.loop.applyDurable(a.update, { recordId: 'w-a',});
    const b = remoteUpdate('B');
    h.loop.applyDurable(b.update, { recordId: 'w-b',});
    const c = remoteUpdate('C');
    h.loop.applyDurable(c.update, { recordId: 'w-c',});

    // The convergence timer is reset on each delta — no write during the burst.
    h.clock.advance(999);
    expect(h.create).not.toHaveBeenCalled();

    // After the burst settles (1s past the LAST delta), exactly ONE re-publish.
    h.clock.advance(1);
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});

describe('flush loop — presence-aware cadence (setTimers)', () => {
  /** Drain the async flush pipeline (create await + post-write bookkeeping). */
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  it('tightening takes effect on the next arming; restoring relaxes again', async () => {
    const h = makeLoop();

    // Default cadence: a change flushes at 2000ms idle, not before.
    h.doc.insertText(0, 'a');
    h.loop.onLocalChange();
    h.clock.advance(1999);
    await settle();
    expect(h.writes().length).toBe(0);
    h.clock.advance(1);
    await settle();
    expect(h.writes().length).toBe(1);

    // Tighten (collaborator arrived): next change flushes at 600ms.
    h.loop.setTimers(FAST_TIMERS);
    h.doc.insertText(1, 'b');
    h.loop.onLocalChange();
    h.clock.advance(600);
    await settle();
    expect(h.writes().length).toBe(2);

    // Restore defaults (collaborator left): 600ms no longer flushes…
    h.loop.setTimers(TEST_TIMERS);
    h.doc.insertText(2, 'c');
    h.loop.onLocalChange();
    h.clock.advance(600);
    await settle();
    expect(h.writes().length).toBe(2);
    // …but the full 2000ms does.
    h.clock.advance(1400);
    await settle();
    expect(h.writes().length).toBe(3);
  });
});

describe('DurableWriter — native create failures and disposal', () => {
  it('publishes the active write before a native callback can request another flush', async () => {
    let nested: Promise<void> | undefined;
    let calls = 0;
    const h = makeLoop({ writeImpl: () => {
      if (++calls === 1) nested = h.loop.flush();
      return okResult();
    } });
    type(h.doc, 'one write');
    await h.loop.flush();
    await nested;
    expect(h.create).toHaveBeenCalledOnce();
    h.loop.dispose();
    h.doc.destroy();
  });

  it.each([new TypeError('Transport unavailable'), backstop(), pageGone()])('preserves the original failed write during a strict drain: %s', async (failure) => {
    const h = makeLoop({ writeImpl: () => failure });
    type(h.doc, 'unsaved');
    await expect(h.loop.drain()).rejects.toBe(failure);
    expect(h.doc.hasUnflushedChanges()).toBe(true);
    if (!('status' in failure)) expect(h.onError).toHaveBeenCalledWith(failure);
    h.loop.dispose();
    h.doc.destroy();
  });

  it.each(['accepted', 'rejected'] as const)('does not access a discarded document after a pending create is %s', async (outcome) => {
    let finish!: (result: TestWriteResult) => void;
    const pending = new Promise<TestWriteResult>(resolve => { finish = resolve; });
    const h = makeLoop({ writeImpl: () => pending });
    type(h.doc, 'discarded');
    const flushing = h.loop.flush();
    h.loop.dispose();
    h.doc.destroy();
    finish(outcome === 'accepted' ? okResult() : transient());
    await expect(flushing).resolves.toBeUndefined();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onParentGone).not.toHaveBeenCalled();
    expect(h.clock.pending()).toBe(0);
  });
});
