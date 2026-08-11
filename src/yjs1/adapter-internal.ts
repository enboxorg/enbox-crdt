/** Internal native state shared only by optional yjs1 adapter subpaths. */

import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

const awarenessInstances = new WeakMap<object, Awareness>();

export function registerNativeAwareness(handle: object, awareness: Awareness): void {
  awarenessInstances.set(handle, awareness);
}

export function unregisterNativeAwareness(handle: object): void {
  awarenessInstances.delete(handle);
}

export function unwrapNativeAwareness(handle: object, expectedDoc: Y.Doc): Awareness {
  const awareness = awarenessInstances.get(handle);
  if (awareness === undefined) {
    throw new Error('Expected an awareness handle created by @enbox/crdt');
  }
  if (awareness.doc !== expectedDoc) {
    throw new Error('The awareness handle belongs to a different collaborative document');
  }
  return awareness;
}
