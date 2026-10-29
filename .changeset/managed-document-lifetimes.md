---
"@enbox/crdt": minor
---

Add DocumentSessions to own collaborative documents through hydration, optional local-cache recovery, autosave, close and reclaim. Preserve failed drains and pending changes across fresh write authority, await adapter cleanup, and keep the existing document and durable-writer primitives available for custom lifecycles.

Validate staged repairs before accepting them, retain read-only local edits, and distinguish pending changes from incomplete recovery with public errors. CodeMirror undo and redo respect read-only views.

Keep terminal-writer repairs exportable and report a stopped writer consistently from managed durability barriers.
