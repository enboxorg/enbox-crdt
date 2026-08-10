/**
 * The Enbox delta envelope — the byte-level contract that makes every CRDT
 * payload self-describing. See SPEC.md §2 for the normative definition.
 *
 * Layout (all offsets in bytes):
 *
 * ```text
 * [0..4)    magic 0x45 0x42 0x58 0x44 ("EBXD")
 * [4]       envelope version (u8) — this module implements version 1
 * [5]       format id length L (u8), 1 <= L <= 32
 * [6..6+L)  format id, ASCII from /^[a-z0-9][a-z0-9-]*$/
 * [6+L..)   payload (0 or more bytes; meaning defined by the format id)
 * ```
 *
 * The envelope exists so a document is never a pile of anonymous bytes: a
 * reader that does not implement the named format can FAIL CLOSED (read-only /
 * derived fallback) instead of corrupting state, and future formats
 * (`loro1`, `automerge1`, …) can enter per-document without a protocol
 * redesign.
 *
 * @module
 */

import { concatBytes } from './bytes.js';

/** The 4-byte envelope magic: ASCII "EBXD" (Enbox Delta). */
export const ENVELOPE_MAGIC: Uint8Array = Uint8Array.from([0x45, 0x42, 0x58, 0x44]);

/** The envelope version this module reads and writes. */
export const ENVELOPE_VERSION = 1;

/** Maximum format-id length in bytes. */
export const MAX_FORMAT_ID_LENGTH = 32;

/** Valid format ids: lowercase alphanumeric plus interior hyphens, 1-32 chars. */
export const FORMAT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Envelope header size for a given format-id length. */
const HEADER_BASE = ENVELOPE_MAGIC.byteLength + 2; // magic + version + id length

/** A decoded envelope. `payload` is a subarray view into the input bytes. */
export interface Envelope {
  /** The registered format id, e.g. `'yjs1'`. */
  format: string;
  /** The format-defined payload bytes. */
  payload: Uint8Array;
}

/** Machine-readable decode failure classes. */
export type EnvelopeErrorCode =
  /** Bytes do not begin with the envelope magic (likely legacy/raw payload). */
  | 'not-an-envelope'
  /** Magic present but the byte stream ends before the declared structure. */
  | 'truncated'
  /** Magic present but the version byte is not one this reader implements. */
  | 'unsupported-version'
  /** The format-id length or characters violate the spec. */
  | 'invalid-format-id';

/** Error thrown by {@link decodeEnvelope}; branch on {@link EnvelopeError.code}. */
export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode;

  constructor(code: EnvelopeErrorCode, message: string) {
    super(message);
    this.name = 'EnvelopeError';
    this.code = code;
  }
}

const ASCII_ENCODER = new TextEncoder();
const ASCII_DECODER = new TextDecoder('ascii', { fatal: false });

/**
 * Encode a payload under a format id. Throws `EnvelopeError('invalid-format-id')`
 * if the id violates {@link FORMAT_ID_PATTERN}. An empty payload is valid (some
 * format frames, e.g. state vectors of empty documents, are legitimately tiny).
 */
export function encodeEnvelope(format: string, payload: Uint8Array): Uint8Array {
  if (!FORMAT_ID_PATTERN.test(format)) {
    throw new EnvelopeError('invalid-format-id', `invalid format id: ${JSON.stringify(format)}`);
  }
  const id = ASCII_ENCODER.encode(format);
  const header = new Uint8Array(HEADER_BASE);
  header.set(ENVELOPE_MAGIC, 0);
  header[4] = ENVELOPE_VERSION;
  header[5] = id.byteLength;
  return concatBytes(header, id, payload);
}

/** Whether the bytes begin with the envelope magic. Cheap sniff for migration paths. */
export function isEnvelope(bytes: Uint8Array): boolean {
  if (bytes.byteLength < ENVELOPE_MAGIC.byteLength) return false;
  for (let i = 0; i < ENVELOPE_MAGIC.byteLength; i++) {
    if (bytes[i] !== ENVELOPE_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Decode an envelope. Throws {@link EnvelopeError} on any failure — including
 * `'not-an-envelope'` when the magic is absent. Fail-closed doctrine: a caller
 * that sees `'unsupported-version'` or a format id it does not implement MUST
 * treat the document as unreadable (read-only / derived fallback), never guess.
 */
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  if (!isEnvelope(bytes)) {
    throw new EnvelopeError('not-an-envelope', 'missing envelope magic');
  }
  if (bytes.byteLength < HEADER_BASE) {
    throw new EnvelopeError('truncated', `envelope header truncated at ${bytes.byteLength} bytes`);
  }
  const version = bytes[4];
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeError('unsupported-version', `unsupported envelope version ${version}`);
  }
  const idLength = bytes[5] as number;
  if (idLength < 1 || idLength > MAX_FORMAT_ID_LENGTH) {
    throw new EnvelopeError('invalid-format-id', `format id length ${idLength} out of range 1..${MAX_FORMAT_ID_LENGTH}`);
  }
  if (bytes.byteLength < HEADER_BASE + idLength) {
    throw new EnvelopeError('truncated', 'format id truncated');
  }
  const format = ASCII_DECODER.decode(bytes.subarray(HEADER_BASE, HEADER_BASE + idLength));
  if (!FORMAT_ID_PATTERN.test(format)) {
    throw new EnvelopeError('invalid-format-id', `invalid format id bytes: ${JSON.stringify(format)}`);
  }
  return { format, payload: bytes.subarray(HEADER_BASE + idLength) };
}

/**
 * Sniffing decode for migration paths: returns `null` when the bytes are NOT an
 * envelope (a legacy raw payload), but still THROWS when the magic is present
 * and the envelope is malformed — corrupt data must surface, not be silently
 * misread as a legacy payload.
 */
export function tryDecodeEnvelope(bytes: Uint8Array): Envelope | null {
  if (!isEnvelope(bytes)) return null;
  return decodeEnvelope(bytes);
}
