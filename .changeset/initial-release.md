---
"@enbox/crdt": minor
---

Initial release: format-tagged, cross-language-safe CRDT sync for Enbox dapps.

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
