# @enbox/crdt

Collaborative document lifecycle helpers for Enbox applications.

The package provides:

- `CollabDoc`, an application-facing text document with change events, undo,
  stable position anchors, durable/live delta application, flush planning, and
  realtime healing;
- a format-tagged delta envelope that lets readers reject unsupported data;
- the pinned `yjs1` format implementation and its runtime dependency;
- optional adapter subpaths for awareness, CodeMirror 6, and IndexedDB; and
- `DocumentSessions` for document ownership, hydration, optional recovery and
  durable writing, with the underlying writer and planning helpers available.

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

## Managed documents

`DocumentSessions` from `@enbox/crdt/enbox` owns one document and writer per key.
Bind native record writes and a loader that returns SDK frames with their record
metadata. The document factory keeps the owner independent of its merge engine.
The native bindings supply record authorization; the owner validates CRDT frames
and gates dispatch with the current application write policy.

```ts
import { DocumentSessions } from '@enbox/crdt/enbox';
import { createYjs1Doc } from '@enbox/crdt/yjs1';
import { createAwareness } from '@enbox/crdt/yjs1/awareness';

const documents = new DocumentSessions({
  createDocument: () => {
    const doc = createYjs1Doc();
    return { doc, awareness: createAwareness(doc) };
  },
  timers: { idleMs: 2000, backstopMs: 30000, convergenceMs: 1000 },
  onError: (key, error) => reportDocumentError(key, error),
});

const session = await documents.open(note.id, {
  create: request => records.create('note/delta', {
    ...request, parentContextId: note.contextId,
  }),
  writable: mayEdit,
  canSquash: maySquash,
  load: async signal => {
    const page = await records.query('note/delta', {
      within: note.contextId, pagination: { limit: 100 },
    });
    const updates = [];
    for await (const record of page) {
      signal.throwIfAborted();
      updates.push({
        data: await record.value(), recordId: record.id,
        snapshot: record.squash === true, messageTimestamp: record.timestamp,
      });
    }
    return updates;
  },
  // Optional; can also be supplied when reopening a headless document.
  persistence: async (doc, signal) => {
    const { createIndexedDbPersistence } = await import('@enbox/crdt/yjs1/indexeddb');
    signal.throwIfAborted();
    return createIndexedDbPersistence(`my-app:note:${note.id}`, doc);
  },
});

if (mayEdit) session.doc.insertText(0, 'Hello'); // One managed listener schedules local writes.
session.writer.applyDurable(frame, { recordId, snapshot, messageTimestamp });
await documents.close(note.id);
```

`open` coalesces creation and returns the same handle while it is retained.
`load` runs only for a new document; prefetched `updates` are applied on every
open, including a rebind to fresh native write authority. Remote/live operations
do not arm the local-change listener. Existing durable convergence and recovery
semantics remain unchanged.

An optional persistence adapter is attached once. Opening waits for `whenSynced`
and a strict durability drain before enabling autosave. A later persistence
upgrade temporarily suspends autosave during that recovery. Attachment failures
can be retried; failed recovery writes retain the document and synced adapter.
Omitting persistence on a subsequent open does not detach it.

`close` joins hydration and drains before disposing. A failed close rejects and
retains the handle; reopen reclaims it, so an older close cannot destroy a newly
claimed document. `get` and `values` include retained closing documents but hide
incomplete hydration. `flush(key)` is best effort; `drain(key)` and `drainAll()`
are strict barriers. Ordinary native operations already issued before an
authority change keep their outcomes; future writes use the current target.

`capturePending()` copies writable residuals for authority repair. Call
`stage(key, update)` on a fresh owner before opening with new authority. Staged
changes survive read-only access and make durability barriers reject with
`PendingDocumentChangesError`. Demoting a writable document also retains its
pending changes; an always-readonly document's live traffic is not staged.

`discard(key)` and `dispose()` explicitly abandon owned state: they fence handles
and stop scheduling immediately, then await adapter cleanup. Cache data is kept
unless `discard(key, { clearPersistence: true })` requests its deletion through
the adapter. Call `drainAll()` before `dispose()` when shutdown must preserve
pending changes. Lifecycle notifications report `opened` (new or reclaimed),
`closing` and `disposed`; notification failures cannot change lifecycle outcomes.

## Document primitives

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

```

`CollabDoc` maintains a live document and a durable shadow. A flush advances
the shadow only after its write is acknowledged. Applying a snapshot replaces
the shadow without discarding live-only work, so omitted operations become the
next residual automatically.

## Custom durable write coordination

`DurableWriter` owns one serialized plan/write/commit sequence per document,
including debounce, sustained-edit backstops, squash-conflict recovery, and
convergence after durable events. Bind the existing native create operation:

```ts
import { DurableWriter } from '@enbox/crdt/enbox';

const writer = new DurableWriter({
  doc,
  create: request => records.create('note/delta', {
    ...request,
    parentContextId: note.contextId,
  }),
  timers: { idleMs: 2000, backstopMs: 30000, convergenceMs: 1000 },
  canSquash: maySquash,
  onParentGone: closeDeletedDocument,
  onError: reportWriteFailure,
});
const stop = doc.onLocalUpdate(() => writer.onLocalChange());

// Route subscribed durable records through the same writer.
writer.applyDurable(frame, { recordId, snapshot, messageTimestamp });

// Before a lifecycle transition that requires durability:
await writer.drain();
stop();
writer.dispose();
offText();
doc.destroy();
```

The callback returns the native record's `id` and `timestamp`, or throws its
original error. The writer supplies `squash` and matching timestamp fields;
protocol paths, parent contexts, and any wire-format conversion stay in the
binding. Application timing values can change with `setTimers()`, and updated
squash authority with `setCanSquash()`.

A backstop can reveal a newer squash before its contents arrive. The document
then discards its outdated durable-shadow assumptions and recovers through a
dependency-complete incremental record. Compaction remains disabled until the
newer snapshot body is observed, preserving operations it has not seen.
If a backstop omits a usable floor, strict drains keep rejecting the original
failure. `capturePendingUpdate()` returns a full repair frame. Hydrate a new
document, merge that frame with `applyLive()`, and construct a replacement writer.

`flush()` makes a best-effort attempt and reports failures through `onError`.
`drain()` persists every remaining operation and rejects on failure, leaving
the document available for retry. `republishNow()` attempts the fresh residual
after local-cache recovery; the application decides when editing may begin.
`dispose()` stops scheduling without discarding or destroying the document.
When using this primitive directly, applications choose when to subscribe to
local changes and how to handle read-only access, failed drains, and terminal
parent deletion. `DocumentSessions` owns document, listener, close and reclaim
tasks for the managed path; its keyed `onParentGone` callback leaves application
navigation and cache-deletion policy with the host.
Notification callback failures do not replace write failures or reject a
background flush.

The planning and commit primitives remain available for custom persistence.

## Re-publishing after a squash

```ts
import {
  addMicrosecondTick,
  classifyWriteResult,
  squashFloorTimestamp,
} from '@enbox/crdt/enbox';

if (classifyWriteResult(error) === 'backstop') {
  const floor = squashFloorTimestamp(error);
  if (floor === undefined) throw error;
  try { addMicrosecondTick(floor); } catch { throw error; }
  const republish = doc.planRepublish({
    afterSquashTs: floor,
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

`planRepublish()` retains the newest observed, acknowledged, or reported
snapshot floor. Supply `afterSquashTs` only when a server rejection reports a
newer floor. Missing or invalid floor metadata requires document reconstruction;
an old shadow cannot establish which dependencies survived the squash.

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

## Framed yjs1 update batching

Batch the frames emitted by `onLocalUpdate()` directly for durable storage or
realtime transport. Every input must be a valid SDK envelope tagged `yjs1`:

```ts
import { mergeYjs1Frames } from '@enbox/crdt/yjs1';

const batch = mergeYjs1Frames(frames);
peer.applyLive(batch);
```

The result is another SDK frame. Empty batches produce a no-op frame; duplicate
updates and deletions retain Yjs merge semantics. Raw updates, malformed
envelopes, and other format tags are rejected. Native payload merging remains
available through the engine's `mergeDeltas` on `@enbox/crdt/yjs1/advanced`.

## Package exports

| Export | Purpose |
| --- | --- |
| `@enbox/crdt` | `CollabDoc`, envelope helpers, engine contracts, and flush planning |
| `@enbox/crdt/yjs1` | Primary document factory, constants, and framed update batching |
| `@enbox/crdt/yjs1/advanced` | Advanced native engine compatibility escape hatch |
| `@enbox/crdt/yjs1/awareness` | Ephemeral participant state and awareness codecs |
| `@enbox/crdt/yjs1/codemirror` | CodeMirror 6 binding and neutral undo lifecycle |
| `@enbox/crdt/yjs1/indexeddb` | Browser persistence lifecycle |
| `@enbox/crdt/enbox` | `DocumentSessions`, durable writers, DWN classification, and squash timestamp helpers |
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
