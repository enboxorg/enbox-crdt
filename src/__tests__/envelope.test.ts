import { describe, expect, it } from 'vitest';

import {
  decodeEnvelope,
  encodeEnvelope,
  EnvelopeError,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  isEnvelope,
  tryDecodeEnvelope,
} from '../envelope.js';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvelopeError) return error.code;
    throw error;
  }
  throw new Error('expected EnvelopeError');
};

describe('envelope', () => {
  it('round-trips format id and payload', () => {
    const payload = Uint8Array.from([9, 8, 7, 0, 255]);
    const bytes = encodeEnvelope('yjs1', payload);
    const decoded = decodeEnvelope(bytes);
    expect(decoded.format).toBe('yjs1');
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it('round-trips an empty payload', () => {
    const decoded = decodeEnvelope(encodeEnvelope('a', new Uint8Array(0)));
    expect(decoded.format).toBe('a');
    expect(decoded.payload.byteLength).toBe(0);
  });

  it('encodes the documented header layout', () => {
    const bytes = encodeEnvelope('yjs1', Uint8Array.from([0xaa]));
    expect(Array.from(bytes.subarray(0, 4))).toEqual(Array.from(ENVELOPE_MAGIC));
    expect(bytes[4]).toBe(ENVELOPE_VERSION);
    expect(bytes[5]).toBe(4);
    expect(new TextDecoder().decode(bytes.subarray(6, 10))).toBe('yjs1');
    expect(bytes[10]).toBe(0xaa);
    expect(bytes.byteLength).toBe(11);
  });

  it('accepts 32-char ids and rejects 33-char and bad-charset ids at encode', () => {
    expect(() => encodeEnvelope('x'.repeat(32), new Uint8Array(0))).not.toThrow();
    expect(code(() => encodeEnvelope('x'.repeat(33), new Uint8Array(0)))).toBe('invalid-format-id');
    expect(code(() => encodeEnvelope('YJS1', new Uint8Array(0)))).toBe('invalid-format-id');
    expect(code(() => encodeEnvelope('', new Uint8Array(0)))).toBe('invalid-format-id');
    expect(code(() => encodeEnvelope('-lead', new Uint8Array(0)))).toBe('invalid-format-id');
  });

  it('classifies decode failures with machine-readable codes', () => {
    expect(code(() => decodeEnvelope(Uint8Array.from([1, 2, 3, 4, 5, 6])))).toBe('not-an-envelope');
    expect(code(() => decodeEnvelope(new Uint8Array(0)))).toBe('not-an-envelope');

    const valid = encodeEnvelope('yjs1', Uint8Array.from([0, 0]));
    expect(code(() => decodeEnvelope(valid.subarray(0, 5)))).toBe('truncated');
    expect(code(() => decodeEnvelope(valid.subarray(0, 8)))).toBe('truncated');

    const badVersion = valid.slice();
    badVersion[4] = 2;
    expect(code(() => decodeEnvelope(badVersion))).toBe('unsupported-version');

    const zeroLen = valid.slice();
    zeroLen[5] = 0;
    expect(code(() => decodeEnvelope(zeroLen))).toBe('invalid-format-id');

    const upper = valid.slice();
    upper[6] = 0x59; // 'Y'
    expect(code(() => decodeEnvelope(upper))).toBe('invalid-format-id');
  });

  it('tryDecodeEnvelope returns null for legacy raw bytes but throws on corrupt envelopes', () => {
    expect(tryDecodeEnvelope(Uint8Array.from([0, 1]))).toBeNull();
    expect(isEnvelope(Uint8Array.from([0, 1]))).toBe(false);

    const corrupt = encodeEnvelope('yjs1', Uint8Array.from([0, 0])).subarray(0, 5);
    expect(isEnvelope(corrupt)).toBe(true);
    expect(code(() => tryDecodeEnvelope(corrupt))).toBe('truncated');
  });
});
