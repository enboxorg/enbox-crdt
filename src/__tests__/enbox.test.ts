import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  addMicrosecondTick,
  BACKSTOP_ERROR_CODE,
  classifyWriteResult,
  computeRepublish,
  formatDwnTimestamp,
  PARENT_GONE_ERROR_CODE,
  PARENT_RECORD_NOT_FOUND_ERROR_CODE,
  squashFloorTimestamp,
} from '../enbox/index.js';
import { decodeEnvelope } from '../envelope.js';
import { yjs1 } from '../yjs1/advanced.js';

describe('classifyWriteResult', () => {
  it('maps status codes to write classes on errorCode, never prose', () => {
    expect(classifyWriteResult({ code: 202 })).toBe('ok');
    expect(classifyWriteResult({ code: 409, errorCode: BACKSTOP_ERROR_CODE })).toBe('backstop');
    expect(classifyWriteResult({ code: 400, errorCode: PARENT_GONE_ERROR_CODE })).toBe('parent-gone');
    expect(classifyWriteResult({ code: 400, errorCode: PARENT_RECORD_NOT_FOUND_ERROR_CODE })).toBe('parent-gone');
    expect(classifyWriteResult({ code: 409, errorCode: 'SomethingElse' })).toBe('error');
    expect(classifyWriteResult({ code: 400, errorCode: BACKSTOP_ERROR_CODE })).toBe('error');
    expect(classifyWriteResult({ code: 500 })).toBe('error');
  });

  it('reads the squash floor as structured data only', () => {
    expect(squashFloorTimestamp({ code: 409, info: { squashFloorTimestamp: '2026-08-10T00:00:00.000000Z' } }))
      .toBe('2026-08-10T00:00:00.000000Z');
    expect(squashFloorTimestamp({ code: 409 })).toBeUndefined();
  });

  it('accepts structural SDK error and result wrappers', () => {
    const wrapped = {
      status: {
        code: 409,
        errorCode: BACKSTOP_ERROR_CODE,
        info: { squashFloorTimestamp: '2026-08-10T00:00:00.000000Z' },
      },
    };
    expect(classifyWriteResult(wrapped)).toBe('backstop');
    expect(squashFloorTimestamp(wrapped)).toBe('2026-08-10T00:00:00.000000Z');
  });
});

describe('DWN timestamps', () => {
  it('formats epoch millis in the exact microsecond ISO-8601 shape', () => {
    const ts = formatDwnTimestamp(Date.UTC(2026, 7, 10, 12, 34, 56, 789));
    expect(ts).toBe('2026-08-10T12:34:56.789000Z');
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it('adds one microsecond within a millisecond', () => {
    expect(addMicrosecondTick('2026-08-10T12:34:56.789123Z')).toBe('2026-08-10T12:34:56.789124Z');
  });

  it('carries across millisecond, second, and day boundaries', () => {
    expect(addMicrosecondTick('2026-08-10T12:34:56.788999Z')).toBe('2026-08-10T12:34:56.789000Z');
    expect(addMicrosecondTick('2026-08-10T12:34:56.999999Z')).toBe('2026-08-10T12:34:57.000000Z');
    expect(addMicrosecondTick('2026-12-31T23:59:59.999999Z')).toBe('2027-01-01T00:00:00.000000Z');
  });

  it('rejects non-microsecond formats', () => {
    expect(() => addMicrosecondTick('2026-08-10T12:34:56.789Z')).toThrow();
    expect(() => addMicrosecondTick('nonsense')).toThrow();
  });
});

describe('computeRepublish', () => {
  const docWithTail = () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, 'acknowledged');
    const remoteSv = yjs1.encodeStateVector(doc);
    doc.getText('content').insert(12, ' + local tail');
    return { doc, remoteSv };
  };

  it('returns null when there is no residual', () => {
    const doc = yjs1.createDoc();
    doc.getText('content').insert(0, 'flushed');
    expect(computeRepublish(yjs1, doc, yjs1.encodeStateVector(doc))).toBeNull();
    yjs1.destroyDoc?.(doc);
  });

  it('returns an enveloped residual without a stamp on the plain path', () => {
    const { doc, remoteSv } = docWithTail();
    const result = computeRepublish(yjs1, doc, remoteSv);
    expect(result).not.toBeNull();
    expect(result?.messageTimestamp).toBeUndefined();
    expect(decodeEnvelope(result!.delta).format).toBe('yjs1');
    yjs1.destroyDoc?.(doc);
  });

  it('stamps strictly past the squash floor when the local clock is behind', () => {
    const { doc, remoteSv } = docWithTail();
    const floor = '2026-08-10T12:00:00.000500Z';
    const behindNow = Date.UTC(2026, 7, 10, 11, 0, 0, 0);
    const result = computeRepublish(yjs1, doc, remoteSv, { afterSquashTs: floor, nowMillis: behindNow });
    expect(result?.messageTimestamp).toBe('2026-08-10T12:00:00.000501Z');
    yjs1.destroyDoc?.(doc);
  });

  it('uses the local clock when it is already past the floor', () => {
    const { doc, remoteSv } = docWithTail();
    const floor = '2026-08-10T12:00:00.000500Z';
    const aheadNow = Date.UTC(2026, 7, 10, 13, 0, 0, 1);
    const result = computeRepublish(yjs1, doc, remoteSv, { afterSquashTs: floor, nowMillis: aheadNow });
    expect(result?.messageTimestamp).toBe('2026-08-10T13:00:00.001000Z');
    yjs1.destroyDoc?.(doc);
  });

  it('the residual applied over the squashed state restores the local tail', () => {
    // A (owner) squashes without ever seeing B's tail; B republished residual heals.
    const a = new Y.Doc();
    a.clientID = 1;
    a.getText('content').insert(0, 'shared base');
    const base = Y.encodeStateAsUpdate(a);

    const b = new Y.Doc();
    b.clientID = 2;
    Y.applyUpdate(b, base);
    b.getText('content').insert(11, ' [B tail]');

    const squash = Y.encodeStateAsUpdate(a); // omits B's op
    const result = computeRepublish(yjs1, b, Y.encodeStateVector(a));
    expect(result).not.toBeNull();

    const merged = new Y.Doc();
    Y.applyUpdate(merged, squash);
    Y.applyUpdate(merged, decodeEnvelope(result!.delta).payload);
    expect(merged.getText('content').toString()).toBe('shared base [B tail]');
    for (const d of [a, b, merged]) d.destroy();
  });
});
