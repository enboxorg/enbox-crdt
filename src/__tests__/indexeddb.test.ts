import 'fake-indexeddb/auto';

import { indexedDB } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { createIndexedDbPersistence } from '../yjs1/indexeddb.js';
import { createYjs1Doc } from '../yjs1/index.js';

let databaseCounter = 0;

describe('yjs1 IndexedDB adapter', () => {
  it('restores persisted operations without exposing the native document', async () => {
    const name = `enbox-crdt-test-${++databaseCounter}`;
    const first = createYjs1Doc();
    const firstPersistence = createIndexedDbPersistence(name, first);
    await firstPersistence.whenSynced;
    first.insertText(0, 'persisted');
    await firstPersistence.destroy();
    await firstPersistence.destroy();
    first.destroy();

    const restored = createYjs1Doc();
    const restoredPersistence = createIndexedDbPersistence(name, restored);
    await restoredPersistence.whenSynced;
    expect(restored.getText()).toBe('persisted');

    await restoredPersistence.clearData();
    await restoredPersistence.clearData();
    restored.destroy();
  });

  it('allows application cleanup after the document closes the provider', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const doc = createYjs1Doc();
      const persistence = createIndexedDbPersistence(`enbox-crdt-test-${++databaseCounter}`, doc);
      await persistence.whenSynced;

      doc.insertText(0, 'remove me');
      doc.destroy();
      await persistence.clearData();
      await persistence.clearData();

      const restored = createYjs1Doc();
      const restoredPersistence = createIndexedDbPersistence(
        `enbox-crdt-test-${databaseCounter}`,
        restored,
      );
      await restoredPersistence.whenSynced;
      expect(restored.getText()).toBe('');
      await restoredPersistence.clearData();
      restored.destroy();

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('rejects readiness when destroyed before synchronization', async () => {
    const doc = createYjs1Doc();
    const persistence = createIndexedDbPersistence(`enbox-crdt-test-${++databaseCounter}`, doc);
    const readiness = persistence.whenSynced;

    await persistence.destroy();
    await expect(readiness).rejects.toMatchObject({ name: 'AbortError' });
    doc.destroy();
  });

  it('retires when another connection upgrades the database', async () => {
    const name = `enbox-crdt-test-${++databaseCounter}`;
    const doc = createYjs1Doc();
    const persistence = createIndexedDbPersistence(name, doc);
    await persistence.whenSynced;

    const upgrade = indexedDB.open(name, 2);
    await new Promise<void>((resolve, reject) => {
      upgrade.onerror = () => reject(upgrade.error);
      upgrade.onsuccess = () => {
        upgrade.result.close();
        resolve();
      };
    });

    expect(() => doc.insertText(0, 'after upgrade')).not.toThrow();
    await persistence.destroy();
    await persistence.clearData();
    doc.destroy();
  });
});
