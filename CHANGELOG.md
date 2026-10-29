# @enbox/crdt

## 0.2.0

### Minor Changes

- [#10](https://github.com/enboxorg/enbox-crdt/pull/10) [`8501f22`](https://github.com/enboxorg/enbox-crdt/commit/8501f22b70af7b243cfc66d81467c0255b718213) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add DocumentSessions to own collaborative documents through hydration, optional local-cache recovery, autosave, close and reclaim. Preserve failed drains and pending changes across fresh write authority, await adapter cleanup, and keep the existing document and durable-writer primitives available for custom lifecycles.

  Validate staged repairs before accepting them, retain read-only local edits, and distinguish pending changes from incomplete recovery with public errors. CodeMirror undo and redo respect read-only views.

  Keep terminal-writer repairs exportable and report a stopped writer consistently from managed durability barriers.

## 0.1.4

### Patch Changes

- [#8](https://github.com/enboxorg/enbox-crdt/pull/8) [`4582157`](https://github.com/enboxorg/enbox-crdt/commit/458215746d97ba9f53d639212767250e2f73b958) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace the application-facing raw update batch helper with mergeYjs1Frames, which validates SDK envelope formats, delegates payload merging to the existing Yjs engine, and returns one framed update. Native raw payload merging remains available through the advanced engine surface.

## 0.1.3

### Patch Changes

- [#6](https://github.com/enboxorg/enbox-crdt/pull/6) [`7188891`](https://github.com/enboxorg/enbox-crdt/commit/718889121065703416f41d74cf03f42f8adea369) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a durable document writer with serialized native creates, configurable scheduling, strict drains, and squash recovery. Newer reported squash floors invalidate outdated durable knowledge so recovery preserves dependency-complete updates, while malformed floors retain an actionable failure and full repair state. Application notification failures leave persistence outcomes unchanged.

## 0.1.2

### Patch Changes

- [#4](https://github.com/enboxorg/enbox-crdt/pull/4) [`a477210`](https://github.com/enboxorg/enbox-crdt/commit/a477210e4861ec91cabeb02a098063f9d7a617c0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Own the yjs1 runtime and add awareness, CodeMirror, and IndexedDB adapters that keep native CRDT objects out of application code. Move native engine access to the explicit `yjs1/advanced` subpath, infer known snapshot floors during re-publish planning, and accept structural SDK status wrappers in write classification.

## 0.1.1

### Patch Changes

- [#2](https://github.com/enboxorg/enbox-crdt/pull/2) [`7e228d5`](https://github.com/enboxorg/enbox-crdt/commit/7e228d53f24c541f8e6d49137b44a32bd966daad) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix deletion-only persistence and realtime healing, fence stale snapshot acknowledgements, and expose explicit re-publish commit bookkeeping.

## 0.1.0

### Minor Changes

- [`9aeb852`](https://github.com/enboxorg/enbox-crdt/commit/9aeb85256ec8cbfe018b1e036afea8d1e83bd0d5) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Initial release: format-tagged, cross-language-safe CRDT sync for Enbox dapps.

  - `CollabDoc` — the application-facing document handle (text editing, change
    events with provenance, undo, stable position anchors, durable/live delta
    application, flush planning, realtime healing) with no Yjs exposure.
  - The delta envelope (`EBXD` + version + format id) with fail-closed decoding;
    SPEC.md is normative.
  - The `yjs1` baseline engine, pinned to the yjs 13.6-era update-v1 wire.
  - DWN integration: write classification, squash-backstop timestamp math, and
    the re-publish invariant.
  - Transport-agnostic state-vector reconciliation for lossy realtime channels.
  - Deterministic conformance fixtures for second-language implementations.
