/**
 * Enbox/DWN integration: keyed document lifecycles, a serialized writer, write-result
 * classification, and squash temporal-backstop timestamp math. Native record
 * callbacks and structural status shapes keep this module SDK-independent.
 *
 * The semantics mirror the server-enforced `$squash` contract in
 * `@enbox/dwn-sdk-js`: a squash write atomically removes strictly older
 * sibling deltas, and an incremental write stamped at-or-below the squash
 * floor is rejected 409 with the floor echoed back. The re-publish invariant:
 * after any rejection or foreign snapshot, publish exactly the residual your
 * local document holds beyond the acknowledged remote state — as a FRESH
 * delta, never a verbatim retry.
 *
 * @module
 */

import type { MergeEngine } from '../engine.js';
import { encodeResidual } from '../plan.js';

/** The DWN reply shape needed to classify a delta write. */
export interface DeltaWriteStatus {
  /** HTTP-style status code from the DWN reply. */
  code: number;
  /** Machine-readable `DwnErrorCode` — never match on detail prose. */
  errorCode?: string;
  /** Structured rejection info; carries the squash floor on backstop replies. */
  info?: { squashFloorTimestamp?: string };
}

/** A structural SDK error/result wrapper carrying a DWN status. */
export interface DeltaWriteStatusCarrier {
  readonly status: DeltaWriteStatus;
}

/** Accepted input for write classification and squash-floor extraction. */
export type DeltaWriteStatusInput = DeltaWriteStatus | DeltaWriteStatusCarrier;

/** Classification of a delta write result. */
export type WriteClass = 'ok' | 'backstop' | 'parent-gone' | 'error';

/** The `DwnErrorCode` of a squash temporal-backstop rejection. */
export const BACKSTOP_ERROR_CODE = 'ProtocolAuthorizationSquashBackstop';

/**
 * The `DwnErrorCode` of the terminal parent-gone rejection: a delta whose
 * parent record was pruned fails referential integrity (HTTP 400). Terminal —
 * never re-publish; tear the document session down.
 */
export const PARENT_GONE_ERROR_CODE = 'ProtocolAuthorizationParentNotFoundConstructingRecordChain';

/** The immediate-parent variant of the terminal parent-gone rejection. */
export const PARENT_RECORD_NOT_FOUND_ERROR_CODE = 'ProtocolAuthorizationParentRecordNotFound';

/**
 * Classify a delta write status. Pure.
 *
 * - `ok`          — 2xx;
 * - `backstop`    — 409 squash backstop (re-publish forward via {@link computeRepublish});
 * - `parent-gone` — 400 parent pruned (terminal; NEVER re-publish);
 * - `error`       — anything else (transient; keep operations local, retry on
 *                   the next convergence opportunity).
 */
export function classifyWriteResult(input: DeltaWriteStatusInput): WriteClass {
  const status = 'status' in input ? input.status : input;
  const { code, errorCode } = status;
  if (code >= 200 && code < 300) return 'ok';
  if (code === 409 && errorCode === BACKSTOP_ERROR_CODE) return 'backstop';
  if (
    code === 400 &&
    (errorCode === PARENT_GONE_ERROR_CODE || errorCode === PARENT_RECORD_NOT_FOUND_ERROR_CODE)
  ) {
    return 'parent-gone';
  }
  return 'error';
}

/** Read the squash floor timestamp from a backstop rejection, if present. */
export function squashFloorTimestamp(input: DeltaWriteStatusInput): string | undefined {
  const status = 'status' in input ? input.status : input;
  const floor = status.info?.squashFloorTimestamp;
  return typeof floor === 'string' ? floor : undefined;
}

/** Options for {@link computeRepublish}. */
export interface RepublishOptions {
  /**
   * A squash floor parsed from a backstop rejection. `CollabDoc.planRepublish`
   * defaults this to its newest observed or acknowledged snapshot; pass an
   * explicit value when a rejection reports a newer floor. When present, the
   * result's `messageTimestamp` is forced to `max(localNow, floor + 1µs)`.
   * `CollabDoc.planRepublish()` also records that floor and invalidates an
   * older shadow before deciding which operations still need persistence.
   */
  afterSquashTs?: string;
  /** Local "now" in epoch milliseconds; injected for deterministic tests. */
  nowMillis?: number;
}

/** A non-null {@link computeRepublish} result. */
export interface RepublishResult {
  /** The envelope-tagged residual to publish as a FRESH delta. */
  delta: Uint8Array;
  /**
   * Explicit `messageTimestamp`/`dateCreated` to stamp on the fresh delta —
   * present only on the backstop path. Absent on plain convergence (the SDK
   * stamps current time).
   */
  messageTimestamp?: string;
}

/**
 * The re-publish invariant: the conservative envelope-tagged residual beyond a
 * remote state vector, or `null` when that summary proves none exists. On the
 * backstop path the result carries a timestamp strictly newer than the observed
 * squash floor. Prefer `CollabDoc.planRepublish()` when both live and durable
 * documents are available; it also suppresses conservative no-op residuals.
 */
export function computeRepublish<TDoc>(
  engine: MergeEngine<TDoc>,
  doc: TDoc,
  remoteStateVector: Uint8Array,
  opts: RepublishOptions = {},
): RepublishResult | null {
  const delta = encodeResidual(engine, doc, remoteStateVector);
  if (delta === null) return null;
  if (opts.afterSquashTs === undefined) return { delta };

  const localNow = formatDwnTimestamp(opts.nowMillis ?? Date.now());
  const floorPlusTick = addMicrosecondTick(opts.afterSquashTs);
  // ISO-8601 microsecond timestamps compare lexicographically === chronologically.
  const messageTimestamp = localNow >= floorPlusTick ? localNow : floorPlusTick;
  return { delta, messageTimestamp };
}

// ---------------------------------------------------------------------------
// Timestamp helpers — replicate the EXACT DWN microsecond ISO-8601 format
// (`YYYY-MM-DDTHH:mm:ss.ffffffZ`, UTC, six fractional digits) without depending
// on the Temporal polyfill dwn-sdk-js uses internally.
// ---------------------------------------------------------------------------

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Format epoch milliseconds as a DWN-accepted ISO-8601 microsecond timestamp.
 * JS `Date` carries millisecond precision, so the trailing three microsecond
 * digits are `000` (sufficient — ε arithmetic operates on the squash floor's
 * own microseconds via {@link addMicrosecondTick}).
 */
export function formatDwnTimestamp(epochMillis: number): string {
  const d = new Date(epochMillis);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}` +
    `.${pad(d.getUTCMilliseconds(), 3)}000Z`
  );
}

/**
 * Add exactly one microsecond to a DWN ISO-8601 microsecond timestamp,
 * carrying across microsecond → millisecond → second … boundaries without
 * losing sub-millisecond precision.
 *
 * @throws if `ts` is not in the `…ffffffZ` microsecond format.
 */
export function addMicrosecondTick(ts: string): string {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/);
  if (!m) {
    throw new Error(`addMicrosecondTick: not a DWN microsecond timestamp: ${ts}`);
  }
  const [, y, mo, day, h, mi, s, frac] = m;
  const baseMillis = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(day),
    Number(h),
    Number(mi),
    Number(s),
    Math.floor(Number(frac) / 1000),
  );
  const subMillisMicros = Number(frac) % 1000;
  const totalMicros = BigInt(baseMillis) * 1000n + BigInt(subMillisMicros) + 1n;
  return formatEpochMicros(totalMicros);
}

/** Format epoch microseconds (BigInt) as a DWN ISO-8601 microsecond timestamp. */
function formatEpochMicros(epochMicros: bigint): string {
  const subMillisMicros = Number(epochMicros % 1000n);
  const epochMillis = Number(epochMicros / 1000n);
  const base = formatDwnTimestamp(epochMillis); // …mmm000Z
  return base.replace(/(\d{3})000Z$/, (_full, ms: string) => `${ms}${pad(subMillisMicros, 3)}Z`);
}

export { DurableWriter } from './durable-writer.js';
export type { DurableWriterOptions, DurableWriterTimers, DurableWriterClock, DurableWriteRequest, DurableWriteRecord } from './durable-writer.js';
export { DocumentSessions, PendingDocumentChangesError } from './document-sessions.js';
export type {
  DocumentLifecycleEvent, DocumentPersistence, DocumentSession, DocumentSessionsOptions,
  DurableDocumentUpdate, OpenDocumentSessionOptions,
} from './document-sessions.js';
