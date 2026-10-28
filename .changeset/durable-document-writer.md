---
"@enbox/crdt": patch
---

Add a durable document writer with serialized native creates, configurable scheduling, strict drains, and squash recovery. Newer reported squash floors invalidate outdated durable knowledge so recovery preserves dependency-complete updates, while malformed floors retain an actionable failure and full repair state. Application notification failures leave persistence outcomes unchanged.
