# @enbox/crdt

Format-tagged, cross-language-safe CRDT sync for Enbox dapps.

Enbox dapps keep collaborative state as end-to-end encrypted, append-only
delta records — relays and storage never see plaintext, so **clients own the
merge**. This package standardizes the part of that stack that must be
identical across every client, in every language:

- **the delta envelope** — a 10-byte, language-trivial header
  (`EBXD` + version + format id) so a document is never anonymous bytes and
  readers that don't implement its format **fail closed** instead of
  corrupting state ([SPEC.md](./SPEC.md) is normative);
- **the `yjs1` baseline format** — Yjs update-v1 encoding, pinned to the
  13.6-era wire (yjs 14 changes it), because it is the only CRDT format with
  independent implementations in Rust (yrs, y-octo), Go (ygo), and JS —
  which is what makes a future Rust/CLI Enbox client realistic **today**;
- **the sync math** proven in notesd — pure flush planning
  (incremental vs snapshot), the re-publish invariant for squash races, DWN
  write classification, and state-vector reconciliation for lossy realtime
  channels;
- **conformance fixtures** — deterministic JSON vectors under
  [`fixtures/`](./fixtures) that a second-language implementation tests
  against.

What it deliberately does **not** do: wrap or hide Yjs. Your app keeps using
`Y.Doc`, editor bindings, `Y.UndoManager`, and persistence directly — this
package only fixes the wire.

## Install

```sh
npm install @enbox/crdt yjs
```

`yjs` is a peer dependency (`>=13.6 <14`), needed only for the
`@enbox/crdt/yjs1` engine.

## Usage

### Writing deltas (the flush path)

```ts
import { planFlush } from '@enbox/crdt';
import { yjs1 } from '@enbox/crdt/yjs1';

const plan = planFlush(yjs1, doc, {
  lastFlushedStateVector,          // engine SV at the last acknowledged write
  distinctDeltasSinceSnapshot,     // count or Set of delta record ids
  lastSnapshotBytes,
  canSnapshot: role !== 'editor',  // squash authority
});

if (plan.kind !== 'noop') {
  await records.create({
    data: plan.delta,              // envelope-tagged bytes
    squash: plan.kind === 'snapshot',
  });
}
```

### Reading deltas (hydration and events)

```ts
import { applyEnvelope } from '@enbox/crdt';
import { yjs1 } from '@enbox/crdt/yjs1';

const outcome = applyEnvelope(yjs1, doc, record.bytes, REMOTE_ORIGIN);
if (!outcome.applied) {
  // fail closed: 'format-mismatch' → read-only surface;
  // 'not-an-envelope' → legacy migration path, if your dapp has one
}
```

### Squash races and backstop rejections

```ts
import { classifyWriteResult, computeRepublish, squashFloorTimestamp } from '@enbox/crdt/enbox';

switch (classifyWriteResult(status)) {
  case 'backstop': {
    const republish = computeRepublish(yjs1, doc, squasherStateVector, {
      afterSquashTs: squashFloorTimestamp(status),
    });
    if (republish) await writeFresh(republish.delta, republish.messageTimestamp);
    break;
  }
  case 'parent-gone': teardown(); break;   // terminal — never re-publish
}
```

### Realtime healing over a lossy channel

```ts
import { wireLiveSync } from '@enbox/crdt/live';

const off = wireLiveSync(yjs1, channel, () => openDoc, () => isCurrent);
// probes on connect + every 3s; replies to behind peers with exactly the
// missing diff; deletion-bearing docs never spray no-op heals.
```

## Cross-language story

The envelope is implementable in any language in an afternoon; the `yjs1`
payload already has independent implementations — a Rust client uses
[yrs](https://github.com/y-crdt/y-crdt), a Go client
[ygo](https://github.com/Deln0r/ygo). Conformance means passing
[`fixtures/`](./fixtures) (see [SPEC.md §6](./SPEC.md)): envelope cases
byte-for-byte, and `yjs1` scenarios converging under any application order.

Adding a future format (`loro1`, `automerge1`, …) is a new
`MergeEngine` + a registry entry in the spec — per-document, no protocol
redesign, because every payload already declares its format.

## Package layout

| Export | Contents |
| --- | --- |
| `@enbox/crdt` | envelope encode/decode, `MergeEngine` seam, `applyEnvelope`, flush planning |
| `@enbox/crdt/yjs1` | the pinned baseline engine (peer dep: yjs 13.6.x) |
| `@enbox/crdt/enbox` | DWN write classification, squash-backstop timestamp math, `computeRepublish` |
| `@enbox/crdt/live` | transport-agnostic state-vector reconciliation (`wireLiveSync`) |

## Development

```sh
bun install
bun run test        # vitest, includes fixture conformance
bun run typecheck
bun run fixtures    # regenerate fixtures (deterministic)
bun run build
```

## Roadmap

- flush-loop state machine (doc + durable-shadow bookkeeping) lifted from
  notesd once its API settles here;
- awareness/presence profile for the live channel;
- `enbox-crdt-rs`: Rust conformance consumer over yrs, validating the same
  fixtures;
- eslint config aligned with the enbox monorepo.

## License

Apache-2.0 · an [Enbox](https://github.com/enboxorg) project
