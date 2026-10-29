---
"@enbox/crdt": minor
---

Replace CollabDoc.connectLiveSync with connectLive for local-update batching,
backpressure, authorized synchronization, optional cursor exchange, and automatic
detachment. Keep wireLiveSync as the lower-level reconciliation primitive.
Roll back partial synchronization attachments when channel setup fails.
Validate timer intervals and isolate broadcast failures from document edits and
durable-write scheduling.
