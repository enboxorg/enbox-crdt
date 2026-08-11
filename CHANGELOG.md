# @enbox/crdt

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
