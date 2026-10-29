import type { CollabDoc, DurableDeltaMeta, FlushCommitResult } from '../collab-doc.js';
import type { FlushPlan } from '../plan.js';
import type { DeltaWriteStatus, RepublishResult, WriteClass } from './index.js';

import { addMicrosecondTick, classifyWriteResult, squashFloorTimestamp } from './index.js';

type PersistenceDocument = Pick<CollabDoc,
  'applyDurable' | 'planFlush' | 'planRepublish' | 'commitFlush' | 'commitRepublish' | 'hasUnflushedChanges' | 'encodeFullState'>;

/** Native create fields for a durable CRDT record. Data is an enveloped collaborative frame. */
export interface DurableWriteRequest {
  data: Uint8Array;
  squash?: true;
  messageTimestamp?: string;
  dateCreated?: string;
}

/** Metadata returned by the native record create operation. */
export interface DurableWriteRecord {
  id: string;
  timestamp: string;
}

/** Application-selected cadence in milliseconds. */
export interface DurableWriterTimers {
  idleMs: number;
  backstopMs: number;
  convergenceMs: number;
}

/** Optional clock for deterministic scheduling. */
export interface DurableWriterClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const REAL_CLOCK: DurableWriterClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Bind one document to native writes without starting a write or owning the document's lifetime. */
export interface DurableWriterOptions {
  doc: PersistenceDocument;
  /** Bind the protocol path, parent, and optional wire-format conversion here. Return the native record or throw. */
  create(request: DurableWriteRequest): Promise<DurableWriteRecord>;
  timers: DurableWriterTimers;
  canSquash?: boolean;
  clock?: DurableWriterClock;
  onParentGone?(): void;
  /** Background failures preserve pending operations; drain() also rejects with the original error. */
  onError?(error: unknown): void;
}

type WriteOutcome =
  | { ok: true; recordId: string; timestamp: string }
  | { ok: false; error: unknown };

function failureStatus(error: unknown): DeltaWriteStatus | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = 'status' in error ? error.status : error;
  return typeof status === 'object' && status !== null && 'code' in status && typeof status.code === 'number'
    ? status as DeltaWriteStatus : undefined;
}

function classifyFailure(error: unknown): WriteClass {
  const status = failureStatus(error);
  return status === undefined ? 'error' : classifyWriteResult(status);
}

function failureFloor(error: unknown): string | undefined {
  const status = failureStatus(error);
  const floor = status === undefined ? undefined : squashFloorTimestamp(status);
  if (floor === undefined) return undefined;
  try { addMicrosecondTick(floor); return floor; } catch { return undefined; }
}

/** @internal Product notifications cannot change persistence outcomes or leak rejections. */
export function notify(callback: () => void): void {
  try { void Promise.resolve(callback()).catch(() => {}); } catch { /* Preserve the write's outcome. */ }
}

/** Serialize durable writes and convergence for one collaborative document; the caller owns document disposal. */
export class DurableWriter {
  private readonly deps: DurableWriterOptions;
  private timers: DurableWriterTimers;
  private readonly clock: DurableWriterClock;
  private readonly doc: PersistenceDocument;
  private canSquash: boolean;

  private disposed = false;
  private idleHandle: unknown;
  private backstopHandle: unknown;
  private convergenceHandle: unknown;
  private flushPending = false;
  private activeWrite: Promise<WriteOutcome | undefined> | undefined;
  private pendingBackstopTs: string | undefined;
  private unverifiableBackstop: { error: unknown } | undefined;

  public constructor(deps: DurableWriterOptions) {
    this.deps = deps;
    this.timers = { ...deps.timers };
    this.clock = deps.clock ?? REAL_CLOCK;
    this.doc = deps.doc;
    this.canSquash = deps.canSquash !== false;
  }

  /** Update the delays used when subsequent timers are armed. */
  public setTimers(partial: Partial<DurableWriterTimers>): void {
    this.timers = { ...this.timers, ...partial };
  }

  /** Apply current squash authority to future flush plans. */
  public setCanSquash(canSquash: boolean): void {
    this.canSquash = canSquash;
  }

  /** Arm the idle debounce and sustained-typing backstop. */
  public onLocalChange(): void {
    if (this.disposed || this.unverifiableBackstop !== undefined) return;
    this.flushPending = true;
    this.clock.clearTimeout(this.idleHandle);
    this.idleHandle = this.clock.setTimeout(() => {
      void this.flush();
    }, this.timers.idleMs);
    if (this.backstopHandle === undefined) {
      this.backstopHandle = this.clock.setTimeout(() => {
        void this.flush();
      }, this.timers.backstopMs);
    }
  }

  /**
   * Capture pending operations while the document is alive, including after this
   * writer stops. Stopped writers and unusable backstop floors return full known
   * state for repair, since a deleted parent may have removed the old baseline.
   */
  public capturePendingUpdate(): Uint8Array | undefined {
    if (this.unverifiableBackstop !== undefined) return this.doc.encodeFullState();
    const pending = this.doc.planRepublish();
    if (pending === null) return undefined;
    return this.disposed ? this.doc.encodeFullState() : pending.delta;
  }

  /**
   * Best-effort persistence reports native failures through onError; use drain() for a strict barrier.
   * A caller arriving during an older write joins it, then starts at most one
   * fresh attempt. Edits made after that fresh plan retain their own debounce.
   */
  public async flush(): Promise<void> {
    if (this.disposed || this.unverifiableBackstop !== undefined) return;
    const joined = this.activeWrite;
    if (joined !== undefined) {
      const result = await joined;
      if (result !== undefined && !result.ok) return;
    }
    if (this.disposed || !this.doc.hasUnflushedChanges()) return;
    const result = await (this.activeWrite ?? this.startFlush());
    if (result !== undefined && !result.ok) return;
  }

  /** Strictly persist every residual before a destructive lifecycle event. */
  public async drain(): Promise<void> {
    this.cancelFlushTimers();
    this.flushPending = false;
    for (;;) {
      if (this.unverifiableBackstop !== undefined) throw this.unverifiableBackstop.error;
      let attempt = this.activeWrite;
      if (attempt === undefined) {
        if (this.disposed || !this.doc.hasUnflushedChanges()) return;
        attempt = this.startFlush();
      }
      const result = await attempt;
      if (result !== undefined && !result.ok) throw result.error;
    }
  }

  /** Start one plan/write attempt and retain its observable outcome. */
  private startFlush(): Promise<WriteOutcome | undefined> {
    this.cancelFlushTimers();
    this.flushPending = false;
    return this.trackWrite(async (): Promise<WriteOutcome | undefined> => {
      let plan = this.planNow();
      if (plan.kind === 'noop') return undefined;

      const republish = this.doc.planRepublish({
        afterSquashTs : this.pendingBackstopTs,
        nowMillis     : this.clock.now(),
      });
      if (republish === null) {
        this.pendingBackstopTs = undefined;
        return undefined;
      }
      const messageTimestamp = republish.messageTimestamp;
      if (plan.kind === 'incremental') {
        plan = { kind: 'incremental', delta: republish.delta };
      }

      const result = await this.write(plan.delta, plan.kind === 'snapshot', messageTimestamp);
      return this.handleWriteResult(plan, result);
    });
  }

  /** Retain one write as the single per-document plan/write/commit lane. */
  private trackWrite(
    operation: () => Promise<WriteOutcome | undefined>,
  ): Promise<WriteOutcome | undefined> {
    let begin!: () => void;
    const attempt = new Promise<WriteOutcome | undefined>((resolve, reject) => {
      begin = () => {
        try { resolve(operation()); } catch (error) { reject(error); }
      };
    });
    // Publish the lane before invoking a native callback that can reenter this writer.
    this.activeWrite = attempt;
    const clear = (): void => {
      if (this.activeWrite === attempt) this.activeWrite = undefined;
    };
    void attempt.then(clear, clear);
    begin();
    return attempt;
  }

  private planNow(): FlushPlan {
    return this.doc.planFlush({ canSnapshot: this.canSquash });
  }

  private async handleWriteResult(
    plan: FlushPlan,
    result: WriteOutcome,
  ): Promise<WriteOutcome | undefined> {
    if (this.disposed) return undefined;
    if (result.ok) {
      const commit = this.doc.commitFlush(plan, {
        recordId         : result.recordId,
        messageTimestamp : result.timestamp,
      });
      if (!commit.committed && commit.reason === 'superseded') {
        return this.republishOnce(commit.squashFloorTimestamp);
      }
      this.applyCommitResult(commit);
      return result;
    }
    const classification = classifyFailure(result.error);
    if (classification === 'parent-gone') {
      this.tearDownGone();
      return result;
    }
    if (classification === 'backstop') {
      const floor = failureFloor(result.error);
      if (floor === undefined) {
        this.rejectUnverifiableBackstop(result.error);
        return result;
      }
      return this.republishOnce(floor);
    }
    notify(() => this.deps.onError?.(result.error));
    return result;
  }

  /** Make one fresh residual attempt beyond a known squash floor. */
  private async republishOnce(
    squashTimestamp: string,
  ): Promise<WriteOutcome | undefined> {
    this.rememberBackstop(squashTimestamp);
    const republish = this.doc.planRepublish({
      afterSquashTs : this.pendingBackstopTs,
      nowMillis     : this.clock.now(),
    });
    if (republish === null) {
      this.pendingBackstopTs = undefined;
      return undefined;
    }

    const result = await this.writeRepublish(republish);
    this.handleRepublishResult(republish, result, true);
    return result;
  }

  /** Apply an enveloped durable record and schedule trailing convergence when it advances storage. */
  public applyDurable(frame: Uint8Array, meta: DurableDeltaMeta = {}): void {
    if (this.disposed) return;
    const outcome = this.doc.applyDurable(frame, meta);
    if (!outcome.applied) {
      notify(() => this.deps.onError?.(new Error(`Unable to apply collaborative delta: ${outcome.reason}`)));
      return;
    }
    if (outcome.advanced || meta.snapshot === true) this.armConvergence();
  }

  private armConvergence(): void {
    if (this.unverifiableBackstop !== undefined) return;
    this.clock.clearTimeout(this.convergenceHandle);
    this.convergenceHandle = this.clock.setTimeout(() => {
      this.convergenceRepublish();
    }, this.timers.convergenceMs);
  }

  /** Best-effort trailing residual publish after a durable event burst. */
  private convergenceRepublish(): void {
    if (this.disposed || this.unverifiableBackstop !== undefined || this.flushPending || this.activeWrite !== undefined) return;
    void this.startRepublish(false);
  }

  /** Attempt an immediate residual publish after local recovery. */
  public async republishNow(): Promise<boolean> {
    for (;;) {
      if (this.disposed || this.unverifiableBackstop !== undefined) return false;
      const joined = this.activeWrite;
      if (joined === undefined) break;
      await joined;
    }

    let committed = false;
    const result = await this.startRepublish(
      true,
      (value) => { committed = value; },
    );
    return result?.ok === true && committed;
  }

  /** Plan a fresh residual only after observing the serialized writer idle. */
  private startRepublish(
    retryBackstop: boolean,
    onCommit?: (committed: boolean) => void,
  ): Promise<WriteOutcome | undefined> {
    return this.trackWrite(async (): Promise<WriteOutcome | undefined> => {
      if (this.disposed) return undefined;
      const republish = this.planRepublish();
      if (republish === null) return undefined;
      const result = await this.writeRepublish(republish);
      if (!this.disposed) {
        const committed = this.handleRepublishResult(republish, result, retryBackstop);
        onCommit?.(committed);
      }
      return result;
    });
  }

  /** Apply one residual-write result under the serialized writer. */
  private handleRepublishResult(
    republish: RepublishResult,
    result: WriteOutcome,
    retryBackstop: boolean,
  ): boolean {
    if (this.disposed) return false;
    if (result.ok) {
      return this.applyCommitResult(this.doc.commitRepublish(republish, {
        recordId         : result.recordId,
        messageTimestamp : result.timestamp,
      }));
    }
    const classification = classifyFailure(result.error);
    if (classification === 'parent-gone') {
      this.tearDownGone();
    } else if (classification === 'backstop') {
      const floor = failureFloor(result.error);
      if (floor === undefined) this.rejectUnverifiableBackstop(result.error);
      else {
        this.rememberBackstop(floor);
        if (retryBackstop) this.armConvergence();
      }
    } else {
      notify(() => this.deps.onError?.(result.error));
    }
    return false;
  }

  private planRepublish(): RepublishResult | null {
    const republish = this.doc.planRepublish({
      afterSquashTs : this.pendingBackstopTs,
      nowMillis     : this.clock.now(),
    });
    if (republish === null) this.pendingBackstopTs = undefined;
    return republish;
  }

  private writeRepublish(republish: RepublishResult): Promise<WriteOutcome> {
    return this.write(republish.delta, false, republish.messageTimestamp);
  }

  private async write(data: Uint8Array, snapshot: boolean, messageTimestamp?: string): Promise<WriteOutcome> {
    try {
      const record = await this.deps.create({
        data,
        ...(snapshot ? { squash: true as const } : {}),
        ...(messageTimestamp === undefined ? {} : { messageTimestamp, dateCreated: messageTimestamp }),
      });
      return { ok: true, recordId: record.id, timestamp: record.timestamp };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /** Return true when the acknowledgement advanced the durable shadow. */
  private applyCommitResult(result: FlushCommitResult): boolean {
    if (result.committed) {
      this.pendingBackstopTs = undefined;
      return true;
    }
    if (result.reason === 'superseded') {
      this.rememberBackstop(result.squashFloorTimestamp);
      this.armConvergence();
    }
    return false;
  }

  private rememberBackstop(timestamp: string): void {
    if (this.pendingBackstopTs === undefined || timestamp > this.pendingBackstopTs) {
      this.pendingBackstopTs = timestamp;
      // Update durability knowledge even if this attempt ends before another plan is requested.
      this.doc.planRepublish({ afterSquashTs: timestamp, nowMillis: this.clock.now() });
    }
  }

  private rejectUnverifiableBackstop(error: unknown): void {
    // The caller must capture repair state, authoritatively rehydrate, and construct a replacement writer.
    this.unverifiableBackstop = { error };
    this.cancelAllTimers();
    notify(() => this.deps.onError?.(error));
  }

  private tearDownGone(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAllTimers();
    notify(() => this.deps.onParentGone?.());
  }

  /** Stop scheduling and ignore late acknowledgements without persisting or destroying the document. */
  public dispose(): void {
    if (this.disposed) {
      this.cancelAllTimers();
      return;
    }
    this.disposed = true;
    this.cancelAllTimers();
  }

  /** Whether explicit disposal or terminal parent deletion ended this writer. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  private cancelFlushTimers(): void {
    this.clock.clearTimeout(this.idleHandle);
    this.clock.clearTimeout(this.backstopHandle);
    this.idleHandle = undefined;
    this.backstopHandle = undefined;
  }

  private cancelAllTimers(): void {
    this.cancelFlushTimers();
    this.clock.clearTimeout(this.convergenceHandle);
    this.convergenceHandle = undefined;
  }
}
