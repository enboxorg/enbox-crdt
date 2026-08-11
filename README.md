# @enbox/crdt

Collaborative document lifecycle helpers for Enbox applications.

The package provides:

- `CollabDoc`, an application-facing text document with change events, undo,
  stable position anchors, durable/live delta application, flush planning, and
  realtime healing;
- a format-tagged delta envelope that lets readers reject unsupported data;
- the pinned `yjs1` format implementation and its runtime dependency;
- optional adapter subpaths for awareness, CodeMirror 6, and IndexedDB; and
- Enbox/DWN helpers for squash backstops, write classification, and fresh
  residual publication.

## Install

```sh
npm install @enbox/crdt
```

The package owns its exact supported Yjs runtime. Applications do not install
or import `yjs`, `y-protocols`, `y-indexeddb`, or `y-codemirror.next`.

The CodeMirror adapter uses the application's CodeMirror instances. Install
the peer packages when using that subpath:

```sh
npm install @codemirror/state @codemirror/view
```

## Document lifecycle

```ts
import { createYjs1Doc } from '@enbox/crdt/yjs1';

const doc = createYjs1Doc();

doc.insertText(0, 'Hello world');
doc.replaceText(0, 5, 'Goodbye');

const offText = doc.onTextChange(({ edits, source }) => {
  renderTextChanges(edits, source);
});

for (const record of await queryDeltaRecords()) {
  doc.applyDurable(await record.value(), {
    recordId: record.id,
    snapshot: record.squash === true,
    messageTimestamp: record.timestamp,
  });
}

const plan = doc.planFlush({ canSnapshot: maySquash });
if (plan.kind !== 'noop') {
  const record = await writeDelta(plan.delta, {
    squash: plan.kind === 'snapshot',
  });
  const outcome = doc.commitFlush(plan, {
    recordId: record.id,
    messageTimestamp: record.timestamp,
  });
  if (!outcome.committed && outcome.reason === 'superseded') {
    scheduleRepublish();
  }
}

offText();
doc.destroy();
```

`CollabDoc` maintains a live document and a durable shadow. A flush advances
the shadow only after its write is acknowledged. Applying a snapshot replaces
the shadow without discarding live-only work, so omitted operations become the
next residual automatically.

## Re-publishing after a squash

```ts
import {
  classifyWriteResult,
  squashFloorTimestamp,
} from '@enbox/crdt/enbox';

if (classifyWriteResult(error) === 'backstop') {
  const republish = doc.planRepublish({
    afterSquashTs: squashFloorTimestamp(error),
  });
  if (republish !== null) {
    const record = await writeFreshDelta(
      republish.delta,
      republish.messageTimestamp,
    );
    doc.commitRepublish(republish, {
      recordId: record.id,
      messageTimestamp: record.timestamp,
    });
  }
}
```

`planRepublish()` automatically uses the newest snapshot timestamp observed or
acknowledged by the document. Supply `afterSquashTs` only when a server
rejection reports a newer floor.

## Realtime healing

```ts
const offUpdates = doc.onLocalUpdate((frame) => {
  channel.broadcastUpdate(frame);
});
const offInbound = channel.onUpdate((frame) => {
  doc.applyLive(frame);
});
const offSync = doc.connectLiveSync(channel);

// Later:
offSync();
offInbound();
offUpdates();
```

Durable records remain authoritative. Realtime updates reduce latency, while
periodic state-vector probes heal dropped frames.

## Awareness

```ts
import { createAwareness } from '@enbox/crdt/yjs1/awareness';

const awareness = createAwareness(doc);
awareness.setLocalStateField('user', {
  name: 'Ada',
  color: '#336699',
});

const offRemote = channel.onAwareness((update) => {
  awareness.applyUpdate(update, 'remote');
});
const offAwareness = awareness.onUpdate((_change, origin) => {
  if (origin !== 'remote') {
    channel.broadcastAwareness(awareness.encodeUpdate([awareness.clientId]));
  }
});
```

Each document has one awareness lifecycle; repeated `createAwareness()` calls
return the same handle so its client clock stays monotonic. The handle also
exposes `getStates()`, `removeStates()`, and idempotent teardown. Its state is
ephemeral and is never part of durable CRDT records.

## CodeMirror 6

```ts
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createCodeMirrorBinding } from '@enbox/crdt/yjs1/codemirror';

const binding = createCodeMirrorBinding(doc, { awareness });

const state = EditorState.create({
  doc: doc.getText(),
  extensions: [binding.extension, applicationEditorTheme],
});
const view = new EditorView({ state });

// Destroy the editor view first, then release the binding.
view.destroy();
binding.destroy();
```

The adapter installs the collaborative text binding and a high-precedence
undo/redo keymap. The returned neutral undo handle exposes `undo()`, `redo()`,
`canUndo()`, `canRedo()`, `clear()`, and `destroy()`.

For tests or non-editor producers that need to publish a compatible cursor:

```ts
import {
  setCodeMirrorAwarenessSelection,
} from '@enbox/crdt/yjs1/codemirror';

setCodeMirrorAwarenessSelection(doc, awareness, { anchor: 4, head: 9 });
```

## IndexedDB persistence

Keep the browser-only adapter behind the same lazy boundary as the editor:

```ts
const { createIndexedDbPersistence } = await import(
  '@enbox/crdt/yjs1/indexeddb'
);

const persistence = createIndexedDbPersistence(databaseName, doc);
await persistence.whenSynced;

// Retain stored data:
await persistence.destroy();

// Or detach and delete it:
await persistence.clearData();
```

The persistence handle owns its teardown and is safe to release more than once,
including after the collaborative document has been destroyed.

## Raw yjs1 payload batching

Enveloped frames should be used for new storage and transports. A protocol that
already stores raw `yjs1` update-v1 payloads can batch them without importing
the runtime:

```ts
import { mergeYjs1Updates } from '@enbox/crdt/yjs1';

const batch = mergeYjs1Updates(rawUpdates);
```

## Package exports

| Export | Purpose |
| --- | --- |
| `@enbox/crdt` | `CollabDoc`, envelope helpers, engine contracts, and flush planning |
| `@enbox/crdt/yjs1` | Primary document factory, constants, and raw update batching |
| `@enbox/crdt/yjs1/advanced` | Advanced native engine compatibility escape hatch |
| `@enbox/crdt/yjs1/awareness` | Ephemeral participant state and awareness codecs |
| `@enbox/crdt/yjs1/codemirror` | CodeMirror 6 binding and neutral undo lifecycle |
| `@enbox/crdt/yjs1/indexeddb` | Browser persistence lifecycle |
| `@enbox/crdt/enbox` | DWN write classification and squash timestamp helpers |
| `@enbox/crdt/live` | Transport-agnostic state-vector reconciliation |

The wire-format contract and conformance fixtures are documented in
[`SPEC.md`](./SPEC.md).

## Development

```sh
bun install
bun run test
bun run typecheck
bun run build
```

## License

Apache-2.0
