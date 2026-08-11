# @enbox/crdt

Format-tagged, cross-language-safe CRDT sync for Enbox dapps — behind an API
where **your application never imports or thinks about Yjs**.

Enbox dapps keep collaborative state as end-to-end encrypted, append-only
delta records — relays and storage never see plaintext, so **clients own the
merge**. This package standardizes the parts of that stack that must be
identical across every client, in every language, and wraps them in one
document handle:

- **`CollabDoc`** — the application-facing document: text editing, change
  events, undo, stable position anchors, durable/live delta application,
  flush planning, and realtime healing. The underlying CRDT library is an
  implementation detail you never touch.
- **the delta envelope** — a 10-byte, language-trivial header
  (`EBXD` + version + format id) so a document is never anonymous bytes and
  readers that don't implement its format **fail closed** instead of
  corrupting state ([SPEC.md](./SPEC.md) is normative);
- **the `yjs1` baseline format** — Yjs update-v1 encoding, pinned to the
  13.6-era wire (yjs 14 changes it), because it is the only CRDT format with
  independent implementations in Rust (yrs, y-octo), Go (ygo), and JS —
  which is what makes a future Rust/CLI Enbox client realistic **today**;
- **the sync bookkeeping proven in notesd** — the live-document/durable-shadow
  model, snapshot (squash) races, the re-publish invariant, and state-vector
  reconciliation for lossy realtime channels;
- **conformance fixtures** — deterministic JSON vectors under
  [`fixtures/`](./fixtures) that a second-language implementation tests
  against.

## Install

```sh
npm install @enbox/crdt yjs
```

`yjs` is a peer dependency of the `@enbox/crdt/yjs1` engine only. It is an
implementation detail: **no application code imports it** (the package's own
lifecycle test suite is written entirely without a `yjs` import).

## Usage

### A document, start to finish

```ts
import { createYjs1Doc } from '@enbox/crdt/yjs1';

const doc = createYjs1Doc();          // CollabDoc, format 'yjs1'

// --- editing ---------------------------------------------------------------
doc.insertText(0, 'Hello world');
doc.replaceText(0, 5, 'Goodbye');
doc.onTextChange(({ edits, source }) => {
  // sequential splices + provenance: 'local' | 'durable' | 'live'
  render(edits, source);
});
doc.undo();
doc.redo();

// --- hydration and durable events ------------------------------------------
for (const record of await queryDeltas()) {
  doc.applyDurable(await record.bytes(), {
    recordId: record.id,
    snapshot: record.squash === true,
    messageTimestamp: record.messageTimestamp,
  });
}

// --- flushing local changes ------------------------------------------------
const plan = doc.planFlush({ canSnapshot: role !== 'editor' });
if (plan.kind !== 'noop') {
  const { record, status } = await writeDelta(plan.delta, {
    squash: plan.kind === 'snapshot',
  });
  if (ok(status)) {
    const commit = doc.commitFlush(plan, {
      recordId: record.id,
      messageTimestamp: record.messageTimestamp,
    });
    if (!commit.committed && commit.reason === 'superseded') {
      // A newer squash won while the write was in flight. The local residual
      // remains pending and must be published past commit.squashFloorTimestamp.
    }
  }
}
```

### Squash races and backstop rejections

```ts
import { classifyWriteResult, squashFloorTimestamp } from '@enbox/crdt/enbox';

switch (classifyWriteResult(status)) {
  case 'backstop': {
    // storage compacted underneath us — publish what it may lack,
    // stamped strictly past the squash floor
    const republish = doc.planRepublish({ afterSquashTs: squashFloorTimestamp(status) });
    if (republish) {
      const { record, status: republishStatus } = await writeFresh(
        republish.delta,
        republish.messageTimestamp,
      );
      if (ok(republishStatus)) {
        doc.commitRepublish(republish, {
          recordId: record.id,
          messageTimestamp: record.messageTimestamp,
        });
      }
    }
    break;
  }
  case 'parent-gone': doc.destroy(); break;  // terminal — never re-publish
  // 'error': transient — keep editing; a later planFlush() carries the residual
}
```

A foreign snapshot arriving by subscription is the same story:
`doc.applyDurable(bytes, { snapshot: true, messageTimestamp })` replaces the
durable shadow, and `doc.planRepublish()` returns whatever the squasher
omitted (or `null`). Local work can never be destroyed by someone else's
compaction.

### Realtime (lossy channel as an accelerator)

```ts
doc.onLocalUpdate((frame) => channel.broadcastUpdate(frame)); // outbound
channel.onUpdate((frame) => doc.applyLive(frame));            // inbound
doc.connectLiveSync(channel);   // SV probes + diff heals; drops self-heal
```

Durable records stay the source of truth; realtime only makes it feel
instant. A dropped frame heals within one probe interval. Because a Yjs state
vector does not report deletions, a deletion-bearing peer conservatively
re-sends its idempotent delete set during reconciliation; this is the bounded
cost of healing a dropped deletion-only frame correctly.

### Cursors and selections

```ts
const anchor = doc.anchorAt(selectionStart);   // Uint8Array — safe to ship to peers
// …concurrent edits happen…
const index = doc.indexOfAnchor(anchor);       // still points at the same character
```

## Where is Yjs in all this?

Behind `@enbox/crdt/yjs1`, as an implementation detail of the `yjs1` format —
the same way a JSON parser is an implementation detail of HTTP. The one
deliberate escape hatch is `doc.unwrap()` (typed as `unwrapYDoc(doc)`), which
exists for native editor bindings (e.g. y-codemirror) until first-class editor
adapters ship. If you don't bind such an editor, there is no reason to ever
see a Yjs type.

## Cross-language story

The envelope is implementable in any language in an afternoon; the `yjs1`
payload already has independent implementations — a Rust client uses
[yrs](https://github.com/y-crdt/y-crdt), a Go client
[ygo](https://github.com/Deln0r/ygo). Conformance means passing
[`fixtures/`](./fixtures) (see [SPEC.md §6](./SPEC.md)): envelope cases
byte-for-byte, and `yjs1` scenarios converging under any application order.
Position anchors use the Yjs relative-position v1 encoding, so cursors
interoperate too.

Adding a future format (`loro1`, `automerge1`, …) means implementing the
`DocEngine` interface and registering the id in the spec — per-document, no
protocol redesign, because every payload already declares its format.

## Package layout

| Export | Contents |
| --- | --- |
| `@enbox/crdt` | `CollabDoc`/`createCollabDoc`, envelope encode/decode, `MergeEngine`/`DocEngine` seams, `applyEnvelope`, flush planning |
| `@enbox/crdt/yjs1` | `createYjs1Doc` — the one import most apps need; the pinned baseline engine (peer dep: yjs 13.6.x); `unwrapYDoc` escape hatch |
| `@enbox/crdt/enbox` | DWN write classification, squash-backstop timestamp math, `computeRepublish` |
| `@enbox/crdt/live` | transport-agnostic state-vector reconciliation (`wireLiveSync`) for custom lifecycles |

## Development

```sh
bun install
bun run test        # vitest, includes fixture conformance
bun run typecheck
bun run fixtures    # regenerate fixtures (deterministic)
bun run build
```

### Releases

Same [changesets](https://github.com/changesets/changesets) flow as the enbox
monorepo: run `bunx --bun changeset` alongside your change and commit the
generated file (`--bun` forces the Bun runtime — the changesets CLI needs
`require(esm)`, which Node 21 lacks; Node 20.19+/22.12+ also work). On push to
`main`, the Release workflow opens (or updates) a "chore: version packages"
PR; merging that PR publishes to npm and tags the release.

## Roadmap

- editor adapter packages (`@enbox/crdt-codemirror` first) so even editor
  bindings need no `unwrap()`;
- awareness/presence profile for the live channel (anchors already cover
  cursor positions);
- `enbox-crdt-rs`: Rust conformance consumer over yrs, validating the same
  fixtures;
- eslint config aligned with the enbox monorepo.

## License

Apache-2.0 · an [Enbox](https://github.com/enboxorg) project
