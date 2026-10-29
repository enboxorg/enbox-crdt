/** CodeMirror 6 binding adapter for collaborative documents. */

import type { Extension, SelectionRange } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import type { CollabDoc } from '../collab-doc.js';
import type { UndoHandle } from '../engine.js';
import type { AwarenessState, CollabAwareness } from './awareness.js';

import { Annotation, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import {
  YRange,
  yRemoteSelections,
  yRemoteSelectionsTheme,
  ySyncFacet,
} from 'y-codemirror.next';
import * as Y from 'yjs';

import { unwrapNativeAwareness } from './adapter-internal.js';
import { unwrapYjs1Document, unwrapYjs1Text } from './internal.js';

const undoManagers = new WeakMap<object, Y.UndoManager>();
const syncAnnotation = Annotation.define<object>();

/** One undo timeline per document text, shared by any mounted editor views. */
function documentUndoManager(text: Y.Text): Y.UndoManager {
  let manager = undoManagers.get(text);
  if (manager === undefined) {
    manager = new Y.UndoManager(text);
    undoManagers.set(text, manager);
  }
  return manager;
}

/** A view-specific transaction origin over the document's shared manager. */
class AdapterSyncConfig {
  public constructor(
    public readonly ytext: Y.Text,
    public readonly awareness: ReturnType<typeof unwrapNativeAwareness> | null,
    public readonly undoManager: Y.UndoManager,
  ) {}

  public toYPos(pos: number, assoc = 0): Y.RelativePosition {
    return Y.createRelativePositionFromTypeIndex(this.ytext, pos, assoc);
  }

  public fromYPos(position: Y.RelativePosition | object): { pos: number; assoc: number } {
    const doc = this.ytext.doc;
    if (doc === null) {
      throw new Error('The collaborative text is not attached to a document');
    }
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(position),
      doc,
    );
    if (absolute === null || absolute.type !== this.ytext) {
      throw new Error('The relative position belongs to a different collaborative document');
    }
    return { pos: absolute.index, assoc: absolute.assoc };
  }

  public toYRange(range: SelectionRange): YRange {
    return new YRange(this.toYPos(range.anchor, range.assoc), this.toYPos(range.head, range.assoc));
  }

  public fromYRange(range: YRange): SelectionRange {
    const anchor = this.fromYPos(range.yanchor);
    const head = this.fromYPos(range.yhead);
    return anchor.pos === head.pos
      ? EditorSelection.cursor(head.pos, head.assoc)
      : EditorSelection.range(anchor.pos, head.pos);
  }
}

function createSyncConfig(
  text: Y.Text,
  awareness: ReturnType<typeof unwrapNativeAwareness> | null,
): AdapterSyncConfig {
  const manager = documentUndoManager(text);
  return new AdapterSyncConfig(text, awareness, manager);
}

/** Options for {@link createCodeMirrorBinding}. */
export interface CodeMirrorBindingOptions<State extends object = AwarenessState> {
  /** Optional awareness handle used for remote cursors and selections. */
  awareness?: CollabAwareness<State>;
}

/** A CodeMirror extension and its local-user undo lifecycle. */
export interface CodeMirrorBinding {
  readonly extension: Extension;
  readonly undoManager: UndoHandle;
  /** Release the binding. Idempotent, including after document destroy. */
  destroy(): void;
}

/** An editor selection expressed as plain CodeMirror offsets. */
export interface CodeMirrorAwarenessSelection {
  readonly anchor: number;
  readonly head: number;
}

/**
 * Bind a collaborative document to CodeMirror 6.
 *
 * The returned extension includes the collaborative text binding and a
 * high-precedence undo/redo keymap. Compose presentation extensions, including
 * custom remote-caret themes, in the application alongside this extension.
 */
export function createCodeMirrorBinding<State extends object = AwarenessState>(
  doc: CollabDoc,
  options: CodeMirrorBindingOptions<State> = {},
): CodeMirrorBinding {
  const nativeDoc = unwrapYjs1Document(doc);
  const text = unwrapYjs1Text(doc);
  const awareness = options.awareness === undefined
    ? null
    : unwrapNativeAwareness(options.awareness, nativeDoc);
  const manager = documentUndoManager(text);
  const viewTeardowns = new Set<() => void>();

  let active = true;
  const assertActive = (): void => {
    if (!active) throw new Error('CodeMirror binding has been destroyed');
  };
  const handleDocumentDestroy = (): void => {
    destroy();
  };
  const destroy = (): void => {
    if (!active) return;
    active = false;
    nativeDoc.off('destroy', handleDocumentDestroy);
    for (const teardown of viewTeardowns) teardown();
    viewTeardowns.clear();
  };
  nativeDoc.on('destroy', handleDocumentDestroy);

  const undoManager: UndoHandle = {
    undo: () => {
      assertActive();
      manager.undo();
    },
    redo: () => {
      assertActive();
      manager.redo();
    },
    canUndo: () => active && manager.undoStack.length > 0,
    canRedo: () => active && manager.redoStack.length > 0,
    clear: () => {
      assertActive();
      manager.clear();
    },
    destroy,
  };

  const undo = (view: EditorView): boolean => {
    if (view.state.readOnly) return false;
    if (active) manager.undo();
    return true;
  };
  const redo = (view: EditorView): boolean => {
    if (view.state.readOnly) return false;
    if (active) manager.redo();
    return true;
  };
  const undoKeymap = [
    { key: 'Mod-z', run: undo, preventDefault: true },
    { key: 'Mod-y', mac: 'Mod-Shift-z', run: redo, preventDefault: true },
    { key: 'Mod-Shift-z', run: redo, preventDefault: true },
  ];
  const syncPlugin = ViewPlugin.define((view) => {
    assertActive();
    const config = createSyncConfig(text, awareness);
    manager.addTrackedOrigin(config);
    let viewActive = true;
    const observer = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
      if (transaction.origin === config) return;
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      let position = 0;
      for (const operation of event.delta) {
        if (operation.insert !== undefined) {
          const insert = typeof operation.insert === 'string' ? operation.insert : '';
          changes.push({ from: position, to: position, insert });
        } else if (operation.delete !== undefined) {
          changes.push({ from: position, to: position + operation.delete, insert: '' });
          position += operation.delete;
        } else if (operation.retain !== undefined) {
          position += operation.retain;
        }
      }
      view.dispatch({ changes, annotations: [syncAnnotation.of(config)] });
    };
    text.observe(observer);
    const release = (): void => {
      if (!viewActive) return;
      viewActive = false;
      text.unobserve(observer);
      viewTeardowns.delete(release);
      manager.removeTrackedOrigin(config);
    };
    viewTeardowns.add(release);

    return {
      update: (update: ViewUpdate): void => {
        if (!viewActive) return;
        const fromRemote = update.transactions.some(
          (transaction) => transaction.annotation(syncAnnotation) === config,
        );
        if (!update.docChanged || fromRemote) return;
        nativeDoc.transact(() => {
          let adjustment = 0;
          update.changes.iterChanges((from, to, _fromB, _toB, insert) => {
            const insertedText = insert.sliceString(0, insert.length, '\n');
            if (from !== to) {
              text.delete(from + adjustment, to - from);
            }
            if (insertedText.length > 0) {
              text.insert(from + adjustment, insertedText);
            }
            adjustment += insertedText.length - (to - from);
          });
        }, config);
      },
      destroy: release,
    };
  });
  const historyInput = EditorView.domEventHandlers({
    beforeinput: (event, view): boolean => {
      if (event.inputType === 'historyUndo') {
        return undo(view);
      }
      if (event.inputType === 'historyRedo') {
        return redo(view);
      }
      return false;
    },
  });
  const facetConfig = createSyncConfig(text, awareness);
  const extensions: Extension[] = [ySyncFacet.of(facetConfig), syncPlugin];
  if (awareness !== null) {
    extensions.push(yRemoteSelectionsTheme, yRemoteSelections);
  }
  extensions.push(historyInput, Prec.high(keymap.of(undoKeymap)));

  return { extension: extensions, undoManager, destroy };
}

/**
 * Publish a cursor/selection compatible with the CodeMirror awareness plugin.
 * Pass `null` to clear the local cursor while retaining other awareness fields.
 */
export function setCodeMirrorAwarenessSelection<State extends object = AwarenessState>(
  doc: CollabDoc,
  awareness: CollabAwareness<State>,
  selection: CodeMirrorAwarenessSelection | null,
): void {
  const nativeDoc = unwrapYjs1Document(doc);
  const nativeAwareness = unwrapNativeAwareness(awareness, nativeDoc);
  if (selection === null) {
    nativeAwareness.setLocalStateField('cursor', null);
    return;
  }

  const text = unwrapYjs1Text(doc);
  for (const offset of [selection.anchor, selection.head]) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
      throw new RangeError(`Selection offset ${offset} is outside the document`);
    }
  }
  nativeAwareness.setLocalStateField('cursor', {
    anchor: Y.createRelativePositionFromTypeIndex(text, selection.anchor),
    head: Y.createRelativePositionFromTypeIndex(text, selection.head),
  });
}
