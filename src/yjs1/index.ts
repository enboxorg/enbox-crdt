/**
 * The application-facing `yjs1` document factory and framed update batching.
 *
 * `yjs1` payloads are Yjs update-v1 bytes. The package owns the exact runtime;
 * native document types are confined to the explicit `yjs1/advanced` subpath.
 *
 * @module
 */

import type { CollabDocOptions } from '../collab-doc.js';

import { CollabDoc, createCollabDoc } from '../collab-doc.js';
import { decodeEnvelope, encodeEnvelope } from '../envelope.js';
import { createYjs1Engine, yjs1 } from './advanced.js';
import { DEFAULT_TEXT_KEY, YJS1_FORMAT } from './constants.js';

export { DEFAULT_TEXT_KEY, YJS1_FORMAT };

/**
 * Coalesce SDK yjs1 update frames into one equivalent frame, including an empty no-op batch.
 * Reject malformed envelopes and other formats before passing payloads to the Yjs engine.
 */
export function mergeYjs1Frames(frames: readonly Uint8Array[]): Uint8Array {
  const payloads = frames.map(frame => {
    const envelope = decodeEnvelope(frame);
    if (envelope.format !== YJS1_FORMAT) {
      throw new TypeError(`mergeYjs1Frames: expected '${YJS1_FORMAT}', received '${envelope.format}'`);
    }
    return envelope.payload;
  });
  return encodeEnvelope(YJS1_FORMAT, yjs1.mergeDeltas!(payloads));
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
