---
"@enbox/crdt": patch
---

Own the yjs1 runtime and add awareness, CodeMirror, and IndexedDB adapters that keep native CRDT objects out of application code. Move native engine access to the explicit `yjs1/advanced` subpath, infer known snapshot floors during re-publish planning, and accept structural SDK status wrappers in write classification.
