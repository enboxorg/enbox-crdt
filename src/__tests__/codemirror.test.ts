// @vitest-environment jsdom

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

import { createAwareness } from '../yjs1/awareness.js';
import {
  createCodeMirrorBinding,
  setCodeMirrorAwarenessSelection,
} from '../yjs1/codemirror.js';
import { unwrapYDoc } from '../yjs1/advanced.js';
import { createYjs1Doc } from '../yjs1/index.js';

function observerCount(doc: object, event: string): number {
  const observable = doc as { _observers: Map<string, Set<unknown>> };
  return observable._observers.get(event)?.size ?? 0;
}

describe('yjs1 CodeMirror adapter', () => {
  it('binds the configured text container and scopes undo to editor-local changes', () => {
    const doc = createYjs1Doc({ textKey: 'body' });
    doc.insertText(0, 'base');
    const binding = createCodeMirrorBinding(doc);
    const view = new EditorView({
      state: EditorState.create({ doc: doc.getText(), extensions: [binding.extension] }),
    });

    const remote = createYjs1Doc({ textKey: 'body' });
    remote.applyDurable(doc.encodeFullState(), { snapshot: true });
    const remoteFrames: Uint8Array[] = [];
    remote.onLocalUpdate((frame) => remoteFrames.push(frame));
    remote.insertText(0, 'R');
    doc.applyLive(remoteFrames[0] as Uint8Array);
    expect(doc.getText()).toBe('Rbase');

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' local' } });
    expect(doc.getText()).toBe('Rbase local');
    expect(binding.undoManager.canUndo()).toBe(true);

    binding.undoManager.undo();
    expect(doc.getText()).toBe('Rbase');
    expect(binding.undoManager.canRedo()).toBe(true);
    binding.undoManager.redo();
    expect(doc.getText()).toBe('Rbase local');

    view.destroy();
    binding.destroy();
    remote.destroy();
    doc.destroy();
  });

  it('publishes compatible cursor selections without exposing native positions', () => {
    const doc = createYjs1Doc();
    doc.insertText(0, 'selection');
    const awareness = createAwareness(doc);

    setCodeMirrorAwarenessSelection(doc, awareness, { anchor: 1, head: 4 });
    expect(awareness.getLocalState()?.cursor).toBeDefined();
    expect(() => setCodeMirrorAwarenessSelection(doc, awareness, { anchor: -1, head: 0 })).toThrow(RangeError);
    setCodeMirrorAwarenessSelection(doc, awareness, null);
    expect(awareness.getLocalState()?.cursor).toBeNull();

    awareness.destroy();
    doc.destroy();
  });

  it('rejects awareness from another document and tears down once after destroy', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const doc = createYjs1Doc();
      const other = createYjs1Doc();
      const awareness = createAwareness(other);
      expect(() => createCodeMirrorBinding(doc, { awareness })).toThrow(/different collaborative document/);
      awareness.destroy();
      expect(() => createCodeMirrorBinding(other, { awareness })).toThrow(/created by @enbox\/crdt/);

      const binding = createCodeMirrorBinding(doc);
      const view = new EditorView({
        state: EditorState.create({ extensions: [binding.extension] }),
      });
      doc.destroy();
      view.destroy();
      binding.destroy();
      binding.destroy();
      expect(consoleError).not.toHaveBeenCalled();

      other.destroy();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reuses document-lifetime sync state across editor remounts', () => {
    const doc = createYjs1Doc();
    const native = unwrapYDoc(doc);

    for (let index = 0; index < 3; index += 1) {
      const binding = createCodeMirrorBinding(doc);
      const view = new EditorView({
        state: EditorState.create({ extensions: [binding.extension] }),
      });
      view.destroy();
      binding.destroy();

      expect(observerCount(native, 'afterTransaction')).toBe(1);
      expect(observerCount(native, 'destroy')).toBe(1);
    }

    doc.destroy();
  });

  it('propagates edits between two views over the same document', () => {
    const doc = createYjs1Doc();
    const firstBinding = createCodeMirrorBinding(doc);
    const secondBinding = createCodeMirrorBinding(doc);
    const firstView = new EditorView({
      state: EditorState.create({ extensions: [firstBinding.extension] }),
    });
    const secondView = new EditorView({
      state: EditorState.create({ extensions: [secondBinding.extension] }),
    });

    firstView.dispatch({ changes: { from: 0, insert: 'first' } });
    expect(secondView.state.doc.toString()).toBe('first');
    secondView.dispatch({ changes: { from: 5, insert: ' second' } });
    expect(firstView.state.doc.toString()).toBe('first second');

    secondBinding.undoManager.undo();
    expect(firstView.state.doc.toString()).toBe('');
    expect(secondView.state.doc.toString()).toBe('');

    firstView.destroy();
    secondView.destroy();
    firstBinding.destroy();
    secondBinding.destroy();
    doc.destroy();
  });

  it('can mount the same binding extension in two views', () => {
    const doc = createYjs1Doc();
    const binding = createCodeMirrorBinding(doc);
    const state = EditorState.create({ extensions: [binding.extension] });
    const firstView = new EditorView({ state });
    const secondView = new EditorView({ state });

    firstView.dispatch({ changes: { from: 0, insert: 'shared' } });
    expect(secondView.state.doc.toString()).toBe('shared');
    secondView.dispatch({ changes: { from: 6, insert: ' extension' } });
    expect(firstView.state.doc.toString()).toBe('shared extension');

    firstView.destroy();
    binding.undoManager.clear();
    secondView.dispatch({ changes: { from: secondView.state.doc.length, insert: '!' } });
    expect(binding.undoManager.canUndo()).toBe(true);
    binding.undoManager.undo();
    expect(secondView.state.doc.toString()).toBe('shared extension');

    secondView.destroy();
    binding.destroy();
    doc.destroy();
  });
});
