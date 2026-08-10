/**
 * Regenerates the conformance fixtures under `fixtures/`.
 *
 * Run with: `bun scripts/generate-fixtures.ts`
 *
 * Yjs update bytes are deterministic given fixed client IDs and a fixed
 * transaction sequence, so committed fixtures are stable across runs. The
 * fixtures are consumed by this package's own tests AND are the conformance
 * target for second-language implementations (yrs/y-octo/ygo consumers): apply
 * each scenario's deltas in ANY order — including duplicates — and the
 * document text must equal `expectedText`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Y from 'yjs';

import { encodeEnvelope } from '../src/envelope.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

// ---------------------------------------------------------------------------
// Envelope fixtures — byte-exact encode/decode cases incl. every error class.
// ---------------------------------------------------------------------------

interface EnvelopeCase {
  name: string;
  bytes: string; // base64
  expect:
    | { format: string; payload: string /* base64 */ }
    | { error: 'not-an-envelope' | 'truncated' | 'unsupported-version' | 'invalid-format-id' };
}

function envelopeFixtures(): { version: number; cases: EnvelopeCase[] } {
  const cases: EnvelopeCase[] = [];

  const emptyYjsUpdate = Uint8Array.from([0x00, 0x00]);
  cases.push({
    name: 'valid: yjs1 with empty-update payload',
    bytes: b64(encodeEnvelope('yjs1', emptyYjsUpdate)),
    expect: { format: 'yjs1', payload: b64(emptyYjsUpdate) },
  });

  cases.push({
    name: 'valid: single-char format id, empty payload',
    bytes: b64(encodeEnvelope('a', new Uint8Array(0))),
    expect: { format: 'a', payload: '' },
  });

  const maxId = 'x'.repeat(32);
  cases.push({
    name: 'valid: 32-char format id',
    bytes: b64(encodeEnvelope(maxId, Uint8Array.from([1, 2, 3]))),
    expect: { format: maxId, payload: b64(Uint8Array.from([1, 2, 3])) },
  });

  cases.push({
    name: 'error: bad magic (legacy raw payload)',
    bytes: b64(Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])),
    expect: { error: 'not-an-envelope' },
  });

  const versioned = encodeEnvelope('yjs1', emptyYjsUpdate).slice();
  versioned[4] = 0x02;
  cases.push({
    name: 'error: unsupported envelope version 2',
    bytes: b64(versioned),
    expect: { error: 'unsupported-version' },
  });

  cases.push({
    name: 'error: header truncated after version byte',
    bytes: b64(encodeEnvelope('yjs1', emptyYjsUpdate).subarray(0, 5)),
    expect: { error: 'truncated' },
  });

  cases.push({
    name: 'error: format id truncated',
    bytes: b64(encodeEnvelope('yjs1', emptyYjsUpdate).subarray(0, 8)),
    expect: { error: 'truncated' },
  });

  const zeroLen = encodeEnvelope('yjs1', emptyYjsUpdate).slice();
  zeroLen[5] = 0;
  cases.push({
    name: 'error: zero-length format id',
    bytes: b64(zeroLen),
    expect: { error: 'invalid-format-id' },
  });

  const upper = encodeEnvelope('yjs1', emptyYjsUpdate).slice();
  upper[6] = 0x59; // 'Y' — uppercase violates the id charset
  cases.push({
    name: 'error: uppercase in format id',
    bytes: b64(upper),
    expect: { error: 'invalid-format-id' },
  });

  return { version: 1, cases };
}

// ---------------------------------------------------------------------------
// yjs1 convergence fixtures — deterministic update payloads + expected text.
// ---------------------------------------------------------------------------

interface Yjs1Scenario {
  name: string;
  /** Raw yjs1 payloads (base64), one per delta record. Apply in ANY order. */
  deltas: string[];
  /** The `content` Y.Text after all deltas are applied, in any order. */
  expectedText: string;
  notes?: string;
}

function docWithClient(clientID: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return doc;
}

function fullState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

function diffSince(doc: Y.Doc, base: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(doc, base);
}

function materialize(deltas: Uint8Array[]): string {
  const doc = new Y.Doc();
  for (const delta of deltas) Y.applyUpdate(doc, delta);
  const text = doc.getText('content').toString();
  doc.destroy();
  return text;
}

function yjs1Fixtures(): { version: number; format: string; generator: string; scenarios: Yjs1Scenario[] } {
  const scenarios: Yjs1Scenario[] = [];

  // --- two writers, concurrent inserts at the same position -----------------
  {
    const a = docWithClient(1);
    a.getText('content').insert(0, 'Hello world');
    const base = fullState(a);
    const baseSv = Y.encodeStateVector(a);

    const b = docWithClient(2);
    Y.applyUpdate(b, base);

    a.getText('content').insert(5, ' brave');
    b.getText('content').insert(5, ' new');
    const aDiff = diffSince(a, baseSv);
    const bDiff = diffSince(b, baseSv);

    const deltas = [base, aDiff, bDiff];
    scenarios.push({
      name: 'two-writer-concurrent-insert',
      deltas: deltas.map(b64),
      expectedText: materialize(deltas),
      notes: 'Both writers insert at offset 5 concurrently from the same base; YATA ordering decides the interleaving deterministically.',
    });
    a.destroy();
    b.destroy();
  }

  // --- insert racing a delete over the same region ---------------------------
  {
    const a = docWithClient(1);
    a.getText('content').insert(0, 'The quick brown fox');
    const base = fullState(a);
    const baseSv = Y.encodeStateVector(a);

    const b = docWithClient(2);
    Y.applyUpdate(b, base);

    a.getText('content').delete(4, 6); // drop 'quick '
    b.getText('content').insert(10, 'and sly '); // inside the doomed region's neighborhood
    const deltas = [base, diffSince(a, baseSv), diffSince(b, baseSv)];
    scenarios.push({
      name: 'insert-vs-delete',
      deltas: deltas.map(b64),
      expectedText: materialize(deltas),
    });
    a.destroy();
    b.destroy();
  }

  // --- snapshot plus a concurrent residual (the squash race shape) ----------
  {
    const a = docWithClient(1);
    a.getText('content').insert(0, 'abc');
    const base = fullState(a);
    const baseSv = Y.encodeStateVector(a);

    const b = docWithClient(2);
    Y.applyUpdate(b, base);
    b.getText('content').insert(3, 'B'); // concurrent op the snapshot will omit

    a.getText('content').insert(0, 'A');
    const snapshot = fullState(a); // full state — a squash body omitting B's op
    const residualB = diffSince(b, baseSv);

    const deltas = [snapshot, residualB];
    scenarios.push({
      name: 'snapshot-plus-concurrent-residual',
      deltas: deltas.map(b64),
      expectedText: materialize(deltas),
      notes: 'A full-state snapshot is a valid delta; a concurrent residual published after a squash must merge in, not vanish.',
    });
    a.destroy();
    b.destroy();
  }

  // --- non-ASCII content across writers --------------------------------------
  {
    const a = docWithClient(7);
    a.getText('content').insert(0, 'שלום עולם 🌍');
    const base = fullState(a);
    const baseSv = Y.encodeStateVector(a);

    const b = docWithClient(9);
    Y.applyUpdate(b, base);
    b.getText('content').insert(0, '¡héllo! ');
    const deltas = [base, diffSince(b, baseSv)];
    scenarios.push({
      name: 'unicode-content',
      deltas: deltas.map(b64),
      expectedText: materialize(deltas),
      notes: 'Yjs text offsets are UTF-16 code units; expectedText is the plain JS string for comparison after full application.',
    });
    a.destroy();
    b.destroy();
  }

  // --- deletion-only tail -----------------------------------------------------
  {
    const a = docWithClient(3);
    a.getText('content').insert(0, 'hello');
    const base = fullState(a);
    const baseSv = Y.encodeStateVector(a);
    a.getText('content').delete(0, 1);
    const deletionOnly = diffSince(a, baseSv);
    const deltas = [base, deletionOnly];
    scenarios.push({
      name: 'deletion-only-tail',
      deltas: deltas.map(b64),
      expectedText: materialize(deltas),
      notes: 'The second delta carries only delete-set changes; appliers must handle structless updates.',
    });
    a.destroy();
  }

  return {
    version: 1,
    format: 'yjs1',
    generator: 'yjs 13.6.31 (update v1 encoding)',
    scenarios,
  };
}

// ---------------------------------------------------------------------------

mkdirSync(FIXTURES_DIR, { recursive: true });

const envelopeJson = JSON.stringify(envelopeFixtures(), null, 2) + '\n';
writeFileSync(join(FIXTURES_DIR, 'envelope.json'), envelopeJson);

const yjs1Json = JSON.stringify(yjs1Fixtures(), null, 2) + '\n';
writeFileSync(join(FIXTURES_DIR, 'yjs1-convergence.json'), yjs1Json);

console.log('fixtures written to', FIXTURES_DIR);
