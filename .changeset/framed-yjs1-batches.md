---
"@enbox/crdt": patch
---

Replace the application-facing raw update batch helper with mergeYjs1Frames, which validates SDK envelope formats, delegates payload merging to the existing Yjs engine, and returns one framed update. Native raw payload merging remains available through the advanced engine surface.
