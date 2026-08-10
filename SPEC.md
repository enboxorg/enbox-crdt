# Enbox CRDT Delta Format — Specification

**Status:** v1 draft · **Envelope version:** 1 · **Date:** 2026-08-10

This document is the normative contract for `@enbox/crdt`. It defines the
byte-level envelope that makes every CRDT payload self-describing, the format
registry, and the invariants an implementation in **any language** must
satisfy to interoperate. The TypeScript package in this repository is the
reference implementation; the JSON files under [`fixtures/`](./fixtures) are
the conformance vectors.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

## 1. Motivation and scope

Enbox dapps store collaborative document state as append-only, end-to-end
encrypted delta records on a DWN. Relays and storage see only ciphertext, so
**all merging happens on clients**. That forces the payloads to be
conflict-free (commutative, idempotent, order-independent) — and it means the
payload encoding is a *protocol surface*: every client, in every language,
must produce and consume the same bytes.

There is no SDO standard for CRDT payloads (IETF and W3C have none as of
2026). The strongest cross-language wire format in practice is the Yjs
update-v1 encoding, independently reimplemented in Rust (yrs, y-octo) and Go
(ygo ×2) with byte-level cross-implementation fixtures. This spec therefore
does two things:

1. wraps every payload in a tiny **envelope** carrying a format id, so
   documents are never anonymous bytes and readers can fail closed; and
2. **registers and pins** `yjs1` as the mandatory baseline format, leaving the
   registry open for future formats (`loro1`, `automerge1`, …) without a
   protocol redesign.

Out of scope for v1: awareness/presence payloads, key management, transport
framing, and storage protocol rules (record paths, `$squash`, roles) — those
belong to each dapp's DWN protocol definition. Appendix A recommends a record
shape.

## 2. The delta envelope

Every durable delta record value and every realtime document frame MUST be an
envelope:

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 4 | magic | `0x45 0x42 0x58 0x44` (ASCII `EBXD`) |
| 4 | 1 | envelope version | `0x01` for this spec |
| 5 | 1 | format id length `L` | `1 ≤ L ≤ 32` |
| 6 | `L` | format id | ASCII matching `^[a-z0-9][a-z0-9-]{0,31}$` |
| 6+L | rest | payload | format-defined bytes; MAY be empty |

Rules:

- **E1.** An encoder MUST write exactly this layout; the encoding is canonical
  (one valid byte sequence per `(format, payload)` pair).
- **E2.** A decoder MUST reject bytes without the magic as *not an envelope*.
  Whether raw (pre-envelope) payloads are accepted on a legacy path is a
  per-dapp migration decision, never a default.
- **E3.** A decoder encountering an unknown envelope version MUST fail closed:
  the record is unreadable; the application SHOULD surface read-only state or
  a derived fallback. It MUST NOT attempt partial interpretation.
- **E4.** A decoder encountering a format id it does not implement MUST fail
  closed the same way. It MUST NOT apply heuristics.
- **E5.** Format ids violating the length or character rules make the envelope
  invalid (corrupt), which is distinct from "legacy raw payload".

## 3. Format registry

### 3.1 `yjs1` — Yjs update v1 (mandatory baseline)

- **Payload:** a Yjs **update, v1 encoding**, as produced by
  `Y.encodeStateAsUpdate` in yjs `>=13.6 <14`. Both incremental diffs and
  full-document states are valid payloads (a full state is itself a valid
  update).
- **State vectors:** where a context calls for a state vector (sync probes,
  §5), the payload is the Yjs **state-vector v1 encoding**
  (`Y.encodeStateVector`).
- **Compatible implementations (2026-08):** yjs 13.6.x (JS, reference),
  yrs 0.27.x (Rust), y-octo (Rust), ygo (Go, both lineages), plus bindings
  over yrs (pycrdt, y-rb, ydotnet, ywasm/yffi).
- **Version pin:** yjs 14 changes the wire encoding (53-bit client IDs,
  attribution codecs). `yjs1` is pinned to the **13.6-era v1 encoding**;
  payloads requiring v14 semantics MUST NOT be written under the `yjs1` id.
  Adopting a later encoding is a new registry entry, not an upgrade.
- **Emptiness:** producers SHOULD NOT emit diffs that carry no new operations.
  Because Yjs re-emits the full delete set in every diff, emptiness MUST be
  judged content-aware (e.g. `Y.parseUpdateMeta(update).to` empty ⇔ no new
  structs), never by payload byte length.
- **Position anchors (informative):** applications exchanging cursor/selection
  positions for `yjs1` documents use the Yjs **relative-position v1**
  encoding (`Y.encodeRelativePosition`), which the independent
  implementations also support. Anchor payloads are application data
  (presence), not deltas, and are out of this spec's normative scope.

### 3.2 Reserved ids

`yjs2`, `loro1`, `automerge1`, `fugue1` are reserved for future definition.
Implementations MUST treat them (and all unregistered ids) per rule E4.

## 4. Document and engine invariants

A *document* is one collaborative unit (e.g. a page) whose state is the merge
of its visible delta payloads.

- **D1.** A document is bound to exactly **one** format id for its entire
  life. Writers MUST NOT mix formats under one document. (Different merge
  algorithms do not converge over each other's operations.)
- **D2.** Delta application MUST be idempotent, commutative, and
  order-independent: any client applying any subset of deltas in any order,
  with any duplication, converges to the same state once it has applied the
  same set.
- **D3.** A full-state payload MUST be a valid delta (so snapshots/compaction
  need no special read path).
- **D4.** A snapshot is an optimization, never an authority: operations
  concurrent with a snapshot MUST survive via re-publication of the residual
  (the operations the snapshot omitted), computed against the snapshot
  producer's state vector.
- **D5.** Readers MUST treat `advanced = false` application results
  (already-known operations, own echoes) as no-ops — no re-render storms, no
  echo re-publication.

## 5. Realtime reconciliation profile

Realtime channels are lossy accelerators; durable records are the floor. The
reconciliation profile:

- **R1.** Peers periodically — and immediately on (re)connect — broadcast a
  **sync probe**: an envelope whose payload is their state vector.
- **R2.** A peer holding operations the prober lacks replies with an envelope
  carrying exactly the missing diff, on a lane that outranks ordinary update
  traffic.
- **R3.** A peer MUST NOT reply to a probe that shows a converged sender —
  including when the local document contains deletions (see §3.1 emptiness).
- **R4.** Frames that are not envelopes, carry a foreign format id, or contain
  undecodable payloads MUST be ignored (fail closed); they MUST NOT tear down
  the session.
- **R5.** Frame kind (probe vs update/heal) is carried by the channel's own
  framing, not by the envelope. The envelope tags *format*, not *role*.

## 6. Conformance

An implementation claims conformance by passing the vectors in
[`fixtures/`](./fixtures):

- **`envelope.json`** — byte-exact encode/decode cases including every error
  class (`not-an-envelope`, `truncated`, `unsupported-version`,
  `invalid-format-id`). Decoders MUST classify each case as listed; encoders
  MUST reproduce the valid cases byte-for-byte.
- **`yjs1-convergence.json`** — `yjs1` payload scenarios. For each scenario,
  applying the listed deltas in **any order, with any duplication**, MUST
  yield a document whose `content` text equals `expectedText`. Scenarios
  cover concurrent inserts, insert-vs-delete races, snapshot-plus-residual
  (the squash race), non-ASCII content, and deletion-only payloads.

Fixtures are regenerated deterministically by `bun scripts/generate-fixtures.ts`
(fixed client IDs, fixed transaction sequences) and verified in CI by the
reference test suite.

## Appendix A — Recommended DWN record shape (informative)

For a dapp protocol storing enveloped deltas, the notesd-proven shape:

- delta records: `dataFormat: application/octet-stream`, schemaless,
  `encryptionRequired`, `$immutable`, `$size` bounded (2 MiB works well),
  `$squash` enabled on the sibling set with squash authority restricted to
  owner/admin roles;
- snapshot writes carry the DWN-level squash flag; the server removes strictly
  older siblings and enforces the temporal backstop;
- on a backstop rejection (409), re-publish the residual stamped strictly
  after the returned floor (`@enbox/crdt/enbox` implements the math);
- hydration applies **all** visible deltas (concurrent residuals legitimately
  coexist beside a snapshot).

## Appendix B — Rationale pointers (informative)

- No IETF/W3C CRDT standard exists (verified 2026-08); Braid-HTTP standardizes
  only a version-envelope vocabulary and is an individual draft.
- RFC 6902/7396 cannot express concurrent text editing (order-dependence,
  whole-string granularity) and have no standardized rebase.
- The `yjs1` choice follows from it being the only CRDT format with multiple
  independent, fixture-verified implementations across languages; the
  envelope's format id is the seam that keeps that choice reversible
  per-document.
