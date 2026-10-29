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

const documents = new DocumentSessions({
  createDocument: createYjs1Doc,
  timers: { idleMs: 2000, backstopMs: 30000, convergenceMs: 1000 },
  onError: (key, error) => reportDocumentError(key, error),
  // Optional; imported only when an open requests recovery.
  persistence: async (key, doc, signal) => {
    const { createIndexedDbPersistence } = await import('@enbox/crdt/yjs1/indexeddb');
    signal.throwIfAborted();
    return createIndexedDbPersistence(`my-app:note:${key}`, doc);
  },
});

const session = await documents.open(note.id, {
  create: request => records.create('note/delta', {
    ...request, parentContextId: note.contextId,
  }),
  writable: mayEdit,
  canSquash: maySquash,
  recover: true,
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
});

if (mayEdit) session.doc.insertText(0, 'Hello'); // One managed listener schedules local writes.
session.applyDurable(frame, { recordId, snapshot, messageTimestamp });
await documents.close(note.id);
```

The stable handle exposes `doc`, `applyDurable` and `setTimers`. Writer lifetime
stays with `DocumentSessions`; the standalone writer below remains available for
custom persistence. Editor/live code can call `createAwareness(session.doc)` to
obtain the existing document-lifetime cached awareness handle.

`open` coalesces creation and returns the same handle while it is retained.
`load` runs only for a new document; prefetched `updates` are applied on every
open, including a rebind to fresh native write authority. Remote/live operations
do not arm the local-change listener. Existing durable convergence and recovery
semantics remain unchanged.

Configure the optional persistence factory on the owner; `recover: true` on
`open` requests its adapter. Headless opens can request recovery later.
An adapter is attached once per document. Opening waits for `whenSynced`
and, when writable, a strict durability drain before enabling autosave. A later
recovery request suspends autosave while cached updates merge. Attachment failures
retry the same configured factory; failed recovery writes retain the document
and synced adapter. Once requested, recovery remains required: a later `open`
retries failed recovery even when `recover` is omitted or false. Requesting
recovery without a configured factory rejects. Persistence adapters must provide
idempotent `destroy` and, when supported, `clearData`;
the shipped IndexedDB adapter already provides this contract.

`whenSynced` marks the initial recovery barrier, not the end of all cache updates.
For example, IndexedDB maintenance can later merge another tab's stored changes.
Those unconfirmed cache changes use the local-update feed: writable sessions
schedule a save and read-only sessions retain them for repair. Network transports
must use `doc.applyLive` or `session.applyDurable` to preserve their distinct origins.

`close` joins hydration and drains before disposing. Concurrent calls share the
current attempt. A failed attempt retains the handle and can be retried with
another `close` after its cause resolves. Reopening instead reclaims the handle;
`drainAll()` can finish retained close requests. An older attempt cannot dispose
a reclaimed document or cancel a newer close. Staged-only keys reject close
until they are opened or explicitly discarded. A key with neither a handle nor
a staged repair closes without work, including after an earlier cleanup failed.

`get` and `values` hide incomplete hydration but include retained closing handles.
`flush(key)` is best effort; `drain(key)` and `drainAll()` are strict barriers.
Hydration and recovery setup are serialized. Rebinding and discard take effect
immediately, including while earlier setup waits. Already-issued native writes
keep their outcomes; future writes use the latest target. Failed encoding during
demotion does not restore obsolete write authority or erase retained work.

`capturePending()` copies writable/local residuals for authority repair, including
read-only edits made during pending or failed recovery. One local-update listener
remains installed while autosave is suspended; recovery never hides those edits.
Call `stage(key, update)` before opening its key. Opening, open and retained keys
reject staging. The whole frame is validated with a temporary bare document, so
malformed bytes cannot replace a valid repair. Initial hydration applies the
repair before exposing the handle, then consumes the staged frame even for
read-only access; the document retains its unconfirmed changes. Recovery captures
the whole state beyond the durable shadow, not only this client's operations:
peer live edits can ride along once there are local changes or a staged repair.
Demotion also retains the former writable document's residual, even if it contains
only peer live edits. This preserves the existing healing policy.

The factory must create a fresh empty in-memory document. If initial hydration
or repair application fails, `open` rejects, destroys the incomplete document,
and keeps the original staged frame for a fresh attempt. Later persistence
failures retain the hydrated document and its changes. All `open` failures reject
its returned promise. `hasPending()`, capture, and lifecycle barriers may inspect
or encode document state; encoding failures propagate rather than report a clean
document, and do not discard retained edits. An unapplied staged repair remains
pending until successful initialization or explicit discard.

`writable: false` controls native write dispatch; it does not make the exposed
`CollabDoc` immutable. If application code edits that document, its local-update
feed retains the changes without writing. An always-read-only document with only
`applyLive` traffic has no pending write obligation. Public lifecycle errors
distinguish the cases that require action:

| Error | Meaning and response |
| --- | --- |
| `DocumentNotReadyError` | Setup has not completed successfully. Retry `open` before draining. |
| `PendingDocumentChangesError` | Retained changes remain. Open with writable access to apply/save them, await durable confirmation, or explicitly discard them. |
| `DocumentWriterDisposedError` | The writer stopped permanently. Capture pending changes, then discard/recreate; rebinding alone cannot restart it. |

A deleted parent stops the private writer. `open` rejects
for a stopped writer; strict drain/close reject while relevant edits or recovery remain.
Pending queries and export still inspect the retained document. Dirty stopped
writers export full state because the old parent may have removed its baseline;
pure capture requires the document to remain alive and never resumes writing.
Capture before explicit discard/recreation when those edits must survive. An
already-ready, clean stopped session can close normally. Applications that
intentionally retire a deleted page should explicitly discard its session from
`onParentGone` after detaching their live/editor bindings.

`discard(key)` and `dispose()` explicitly abandon owned state: they fence handles
and stop scheduling immediately, then await adapter cleanup. Cache data is kept
unless `discard(key, { clearPersistence: true })` requests its deletion through
the managed adapter. Choose that policy on the first discard, before retirement.
A later discard cannot upgrade an in-flight cleanup or delete a detached cache;
after close, use the host's cache policy to clear stored data. Await the original
operation for its cleanup result. Call `drainAll()` before `dispose()` when shutdown
must preserve pending changes. Lifecycle notifications report `opened` (new or
reclaimed), `closing` (a close attempt, which may reject while retaining the handle), and
`disposed` (ownership fenced and the document destroyed). These are notifications,
not a complete state machine. Await the operation's promise for asynchronous
adapter cleanup; `disposed` can arrive before that cleanup settles. After a
graceful close has drained changes, adapter cleanup can still reject after retirement.
Failed initial opens emit no lifecycle notifications. Notification failures
cannot change lifecycle outcomes.

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

## Live collaboration

Attach an open document to your encrypted channel with `connectLive()`. Supply
`canWritePeer` from current verified transport-peer and role records; the binding
checks it for every incoming sync or cursor frame. Your receive path continues to
admit document updates, including any permission checks across asynchronous opens.

```ts
import { createAwareness } from '@enbox/crdt/yjs1/awareness';

const awareness = createAwareness(doc);
awareness.setLocalStateField('user', { name: 'Ada', color: '#336699' });

const offInbound = channel.onUpdate((frame, peerId) => {
  if (canWritePeer(peerId)) doc.applyLive(frame);
});
const detach = doc.connectLive(channel, {
  canWrite: canWritePeer,
  awareness,
});

// Later:
offInbound();
detach();
```

Local edits send immediately, then coalesce over 200 ms; cursor changes coalesce
over 300 ms. Channel backpressure can lengthen subsequent batches. These delays
and the 3000 ms sync-probe interval are configurable. Engines without a batch
merge operation send each queued frame individually. Remote live/durable frames
do not echo through the local-update feed.

Use `broadcast: false` for a receive-only attachment: it receives admitted cursors
without sending edits, sync probes, heal replies, or cursor announcements. Omit
`awareness` for text-only channels. Otherwise the channel must provide both
`onAwareness` and `broadcastAwareness`.

Detach is idempotent and also runs on document destruction. It releases listeners
and timers, sends remaining local frames and cursor departure best-effort, clears
remote cursors, and preserves local cursor state for reattachment. Browsers also
announce cursor departure on `pagehide`. The application still owns the channel.

Durable writes remain separate: small live batches reduce latency; later DWN
records confirm the same operations in the durable shadow. Receiving those records
does not reapply already-merged text. `DocumentSessions` retains document and writer
ownership. Custom integrations can use the lower-level `wireLiveSync()` primitive
from `@enbox/crdt/live` for reconciliation alone.

## Awareness

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

Custom integrations can batch frames emitted by `onLocalUpdate()` directly.
`connectLive()` already owns ordinary live batching. Every input to the lower-level
batch helper must be a valid SDK envelope tagged `yjs1`:

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
| `@enbox/crdt/live` | Live channel/options types and low-level state-vector reconciliation |

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
