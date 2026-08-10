# @enbox/crdt

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
