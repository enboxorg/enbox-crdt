/** Ephemeral participant state for collaborative cursors and presence. */

import type { CollabDoc } from '../collab-doc.js';

import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';

import { registerNativeAwareness, unregisterNativeAwareness } from './adapter-internal.js';
import { unwrapYjs1Document } from './internal.js';

const awarenessHandles = new WeakMap<object, Yjs1Awareness<object>>();

/** One participant's application-defined ephemeral state. */
export type AwarenessState = Record<string, unknown>;

/** Client ids affected by one awareness update. */
export interface AwarenessChange {
  readonly added: readonly number[];
  readonly updated: readonly number[];
  readonly removed: readonly number[];
}

/** Application-facing awareness handle. */
export interface CollabAwareness<State extends object = AwarenessState> {
  /** Stable client id shared with this document's realtime cursor binding. */
  readonly clientId: number;

  getLocalState(): State | null;
  setLocalState(state: State | null): void;
  setLocalStateField<Field extends Extract<keyof State, string>>(field: Field, value: State[Field]): void;
  getStates(): ReadonlyMap<number, State>;

  /** Encode selected clients, or every currently known client when omitted. */
  encodeUpdate(clientIds?: readonly number[]): Uint8Array;
  /** Apply an encoded remote awareness update. */
  applyUpdate(update: Uint8Array, origin?: unknown): void;
  /** Remove selected clients locally before broadcasting the resulting update. */
  removeStates(clientIds: readonly number[], origin?: unknown): void;

  /** Observe awareness changes. The returned teardown is idempotent. */
  onUpdate(listener: (change: AwarenessChange, origin: unknown) => void): () => void;
  /** Stop timers and observers. Detach live bindings first; safe to repeat after document destroy. */
  destroy(): void;
}

class Yjs1Awareness<State extends object> implements CollabAwareness<State> {
  private readonly native: Awareness;
  private readonly nativeDoc: ReturnType<typeof unwrapYjs1Document>;
  private readonly teardowns = new Set<() => void>();
  private finalListenerError: unknown;
  private hasFinalListenerError = false;
  private destroying = false;
  private destroyed = false;

  public constructor(doc: CollabDoc) {
    this.nativeDoc = unwrapYjs1Document(doc);
    this.native = new Awareness(this.nativeDoc);
    registerNativeAwareness(this, this.native);
    this.native.on('destroy', this.handleNativeDestroyStart);
    // Awareness emits its final local-null update after its own destroy event.
    // This later document listener completes facade teardown only afterward.
    this.nativeDoc.on('destroy', this.handleDocumentDestroy);
  }

  public get clientId(): number {
    return this.native.clientID;
  }

  public get isDestroyed(): boolean {
    return this.destroyed;
  }

  public getLocalState(): State | null {
    this.assertAlive();
    return this.native.getLocalState() as State | null;
  }

  public setLocalState(state: State | null): void {
    this.assertAlive();
    this.native.setLocalState(state);
  }

  public setLocalStateField<Field extends Extract<keyof State, string>>(field: Field, value: State[Field]): void {
    this.assertAlive();
    this.native.setLocalStateField(field, value);
  }

  public getStates(): ReadonlyMap<number, State> {
    this.assertAlive();
    return this.native.getStates() as Map<number, State>;
  }

  public encodeUpdate(clientIds?: readonly number[]): Uint8Array {
    this.assertAlive();
    return encodeAwarenessUpdate(this.native, [...(clientIds ?? this.native.getStates().keys())]);
  }

  public applyUpdate(update: Uint8Array, origin?: unknown): void {
    this.assertAlive();
    applyAwarenessUpdate(this.native, update, origin);
  }

  public removeStates(clientIds: readonly number[], origin?: unknown): void {
    this.assertAlive();
    removeAwarenessStates(this.native, [...clientIds], origin);
  }

  public onUpdate(listener: (change: AwarenessChange, origin: unknown) => void): () => void {
    this.assertAlive();
    const handler = (change: AwarenessChange, origin: unknown): void => {
      try {
        listener(change, origin);
      } catch (error) {
        if (!this.destroying) throw error;
        if (!this.hasFinalListenerError) {
          this.hasFinalListenerError = true;
          this.finalListenerError = error;
        }
      }
    };
    this.native.on('update', handler);

    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      this.teardowns.delete(release);
      if (!this.destroying && !this.destroyed) {
        this.native.off('update', handler);
      }
    };
    this.teardowns.add(release);
    return release;
  }

  public destroy(): void {
    if (this.destroying || this.destroyed) return;
    let hasListenerError = false;
    let listenerError: unknown;
    try {
      this.native.destroy();
    } finally {
      hasListenerError = this.hasFinalListenerError;
      listenerError = this.finalListenerError;
      this.finishDestroy();
    }
    if (hasListenerError) throw listenerError;
  }

  private readonly handleNativeDestroyStart = (): void => {
    if (this.destroying || this.destroyed) return;
    this.destroying = true;
    unregisterNativeAwareness(this);
  };

  private readonly handleDocumentDestroy = (): void => {
    this.finishDestroy();
  };

  private finishDestroy(): void {
    if (this.destroyed) return;
    this.destroying = true;
    this.destroyed = true;
    unregisterNativeAwareness(this);
    this.nativeDoc.off('destroy', this.handleDocumentDestroy);
    for (const teardown of this.teardowns) teardown();
    this.teardowns.clear();
    this.hasFinalListenerError = false;
    this.finalListenerError = undefined;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Awareness handle has been destroyed');
  }
}

/**
 * Return the document-lifetime awareness handle bound to a collaborative
 * document. Repeated calls return the same handle so one client id has one
 * monotonic awareness clock.
 */
export function createAwareness<State extends object = AwarenessState>(
  doc: CollabDoc,
): CollabAwareness<State> {
  const nativeDoc = unwrapYjs1Document(doc);
  const existing = awarenessHandles.get(nativeDoc);
  if (existing !== undefined) {
    if (existing.isDestroyed) {
      throw new Error('Awareness lifecycle has ended for this collaborative document');
    }
    return existing as unknown as CollabAwareness<State>;
  }

  const awareness = new Yjs1Awareness<State>(doc);
  awarenessHandles.set(nativeDoc, awareness as unknown as Yjs1Awareness<object>);
  return awareness;
}
