/** Internal native access shared by the yjs1 engine and its adapter subpaths. */

import type * as Y from 'yjs';

import type { CollabDoc } from '../collab-doc.js';
import { DEFAULT_TEXT_KEY, YJS1_FORMAT } from './constants.js';

const textKeys = new WeakMap<Y.Doc, string>();

/** Remember the primary text container selected by one engine-created document. */
export function registerYjs1Document(doc: Y.Doc, textKey: string): void {
  textKeys.set(doc, textKey);
}

/** Resolve the native document for an implementation adapter. */
export function unwrapYjs1Document(doc: CollabDoc): Y.Doc {
  if (doc.format !== YJS1_FORMAT) {
    throw new Error(`Expected a '${YJS1_FORMAT}' document, received '${doc.format}'`);
  }
  return doc.unwrap() as Y.Doc;
}

/** Resolve the configured primary text container for an implementation adapter. */
export function unwrapYjs1Text(doc: CollabDoc): Y.Text {
  const native = unwrapYjs1Document(doc);
  return native.getText(textKeys.get(native) ?? DEFAULT_TEXT_KEY);
}
