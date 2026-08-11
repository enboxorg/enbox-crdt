/**
 * The application-facing `yjs1` document factory and raw update helpers.
 *
 * `yjs1` payloads are Yjs update-v1 bytes. The package owns the exact runtime;
 * native document types are confined to the explicit `yjs1/advanced` subpath.
 *
 * @module
 */

import type { CollabDocOptions } from '../collab-doc.js';

import * as Y from 'yjs';

import { CollabDoc, createCollabDoc } from '../collab-doc.js';
import { createYjs1Engine, yjs1 } from './advanced.js';
import { DEFAULT_TEXT_KEY, YJS1_FORMAT } from './constants.js';

export { DEFAULT_TEXT_KEY, YJS1_FORMAT };

/** Coalesce raw yjs1 update-v1 payloads into one equivalent payload. */
export function mergeYjs1Updates(payloads: readonly Uint8Array[]): Uint8Array {
  return Y.mergeUpdates([...payloads]);
}

/** Options for {@link createYjs1Doc}. */
export interface Yjs1DocOptions extends CollabDocOptions {
  /** Primary shared-text container key. Defaults to {@link DEFAULT_TEXT_KEY}. */
  textKey?: string;
}

/** Create a collaborative document over the package-owned yjs1 runtime. */
export function createYjs1Doc(options: Yjs1DocOptions = {}): CollabDoc {
  const engine = options.textKey === undefined ? yjs1 : createYjs1Engine({ textKey: options.textKey });
  return createCollabDoc(engine, { snapshotPolicy: options.snapshotPolicy });
}
