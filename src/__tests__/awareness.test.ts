import { describe, expect, it, vi } from 'vitest';

import { createAwareness } from '../yjs1/awareness.js';
import { createYjs1Doc } from '../yjs1/index.js';

interface ParticipantState {
  user?: { name: string; color: string };
}

describe('yjs1 awareness adapter', () => {
  it('encodes, applies, and removes ephemeral participant state', () => {
    const senderDoc = createYjs1Doc();
    const receiverDoc = createYjs1Doc();
    const sender = createAwareness<ParticipantState>(senderDoc);
    const receiver = createAwareness<ParticipantState>(receiverDoc);
    const changes: Array<{ origin: unknown; added: readonly number[]; removed: readonly number[] }> = [];
    const off = receiver.onUpdate((change, origin) => {
      changes.push({ origin, added: change.added, removed: change.removed });
    });

    sender.setLocalStateField('user', { name: 'Ada', color: '#336699' });
    receiver.applyUpdate(sender.encodeUpdate([sender.clientId]), 'remote');

    expect(receiver.getStates().get(sender.clientId)?.user).toEqual({ name: 'Ada', color: '#336699' });
    expect(changes.at(-1)).toMatchObject({ origin: 'remote', added: [sender.clientId] });

    sender.removeStates([sender.clientId], 'local-leave');
    receiver.applyUpdate(sender.encodeUpdate([sender.clientId]), 'remote');
    expect(receiver.getStates().has(sender.clientId)).toBe(false);
    expect(changes.at(-1)).toMatchObject({ origin: 'remote', removed: [sender.clientId] });

    off();
    sender.destroy();
    receiver.destroy();
    senderDoc.destroy();
    receiverDoc.destroy();
  });

  it('makes listener and awareness teardown idempotent across document destroy', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const doc = createYjs1Doc();
      const awareness = createAwareness(doc);
      const off = awareness.onUpdate(() => undefined);

      doc.destroy();
      off();
      off();
      awareness.destroy();
      awareness.destroy();

      expect(consoleError).not.toHaveBeenCalled();
      expect(() => awareness.getStates()).toThrow(/destroyed/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('uses one monotonic awareness lifecycle per document', () => {
    const doc = createYjs1Doc();
    const first = createAwareness<ParticipantState>(doc);
    const second = createAwareness<ParticipantState>(doc);

    expect(second).toBe(first);
    first.setLocalStateField('user', { name: 'Ada', color: '#336699' });
    expect(second.getLocalState()?.user?.name).toBe('Ada');

    second.destroy();
    expect(() => createAwareness(doc)).toThrow(/lifecycle has ended/);
    doc.destroy();
  });

  it('delivers the final local-null update before listener teardown', () => {
    const senderDoc = createYjs1Doc();
    const receiverDoc = createYjs1Doc();
    const sender = createAwareness<ParticipantState>(senderDoc);
    const receiver = createAwareness<ParticipantState>(receiverDoc);
    const senderClientId = sender.clientId;
    sender.setLocalStateField('user', { name: 'Ada', color: '#336699' });
    receiver.applyUpdate(sender.encodeUpdate(), 'remote');

    let finalUpdate: Uint8Array | undefined;
    sender.onUpdate((change) => {
      if (change.removed.includes(senderClientId)) {
        finalUpdate = sender.encodeUpdate([senderClientId]);
      }
    });
    senderDoc.destroy();

    expect(finalUpdate).toBeDefined();
    receiver.applyUpdate(finalUpdate as Uint8Array, 'remote');
    expect(receiver.getStates().has(senderClientId)).toBe(false);

    receiver.destroy();
    receiverDoc.destroy();
  });

  it('finishes teardown when a final-removal listener throws', () => {
    const explicitDoc = createYjs1Doc();
    const explicit = createAwareness(explicitDoc);
    const expected = new Error('listener failed');
    let trailingListenerCalled = false;
    explicit.onUpdate((change) => {
      if (change.removed.includes(explicit.clientId)) throw expected;
    });
    explicit.onUpdate((change) => {
      if (change.removed.includes(explicit.clientId)) trailingListenerCalled = true;
    });

    expect(() => explicit.destroy()).toThrow(expected);
    expect(trailingListenerCalled).toBe(true);
    expect(() => explicit.getStates()).toThrow(/destroyed/);
    explicitDoc.destroy();

    const ownedDoc = createYjs1Doc();
    const owned = createAwareness(ownedDoc);
    owned.onUpdate((change) => {
      if (change.removed.includes(owned.clientId)) throw new Error('owned listener failed');
    });
    expect(() => ownedDoc.destroy()).not.toThrow();
    expect(() => owned.getStates()).toThrow(/destroyed/);
  });
});
