/**
 * Conformance-fixture verification. These are the same JSON files a
 * second-language implementation (yrs/y-octo/ygo consumer) tests against;
 * this suite keeps the committed fixtures true for the reference (yjs) side.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { applyEnvelope } from '../engine.js';
import { decodeEnvelope, encodeEnvelope, EnvelopeError } from '../envelope.js';
import { yjs1 } from '../yjs1/index.js';

const readFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8')) as T;

const fromB64 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'base64'));
const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

interface EnvelopeFixtures {
  version: number;
  cases: Array<{
    name: string;
    bytes: string;
    expect: { format: string; payload: string } | { error: string };
  }>;
}

interface Yjs1Fixtures {
  version: number;
  format: string;
  scenarios: Array<{ name: string; deltas: string[]; expectedText: string }>;
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

describe('envelope fixtures', () => {
  const fixtures = readFixture<EnvelopeFixtures>('envelope.json');

  it('covers every declared error class at least once', () => {
    const errors = new Set(
      fixtures.cases.map((c) => ('error' in c.expect ? c.expect.error : null)).filter(Boolean),
    );
    expect(errors).toEqual(new Set(['not-an-envelope', 'truncated', 'unsupported-version', 'invalid-format-id']));
  });

  for (const testCase of fixtures.cases) {
    it(testCase.name, () => {
      const bytes = fromB64(testCase.bytes);
      if ('error' in testCase.expect) {
        try {
          decodeEnvelope(bytes);
          throw new Error('expected decode to fail');
        } catch (error) {
          expect(error).toBeInstanceOf(EnvelopeError);
          expect((error as EnvelopeError).code).toBe(testCase.expect.error);
        }
      } else {
        const decoded = decodeEnvelope(bytes);
        expect(decoded.format).toBe(testCase.expect.format);
        expect(toB64(decoded.payload)).toBe(testCase.expect.payload);
        // Re-encoding is byte-identical (canonical encoding).
        expect(toB64(encodeEnvelope(decoded.format, decoded.payload))).toBe(testCase.bytes);
      }
    });
  }
});

describe('yjs1 convergence fixtures', () => {
  const fixtures = readFixture<Yjs1Fixtures>('yjs1-convergence.json');

  it('declares the yjs1 format', () => {
    expect(fixtures.format).toBe('yjs1');
    expect(fixtures.scenarios.length).toBeGreaterThanOrEqual(5);
  });

  for (const scenario of fixtures.scenarios) {
    it(`${scenario.name}: converges under any order, with duplicates`, () => {
      const deltas = scenario.deltas.map(fromB64);
      const orders = [
        deltas,
        deltas.slice().reverse(),
        seededShuffle(deltas, 7),
        seededShuffle([...deltas, ...deltas], 11), // duplicates — idempotence
      ];
      for (const order of orders) {
        const doc = yjs1.createDoc();
        for (const delta of order) yjs1.applyDelta(doc, delta);
        expect(doc.getText('content').toString()).toBe(scenario.expectedText);
        yjs1.destroyDoc?.(doc);
      }
    });

    it(`${scenario.name}: applies identically through the envelope path`, () => {
      const doc = yjs1.createDoc();
      for (const delta of scenario.deltas) {
        const outcome = applyEnvelope(yjs1, doc, encodeEnvelope('yjs1', fromB64(delta)));
        expect(outcome.applied).toBe(true);
      }
      expect(doc.getText('content').toString()).toBe(scenario.expectedText);
      yjs1.destroyDoc?.(doc);
    });
  }
});
