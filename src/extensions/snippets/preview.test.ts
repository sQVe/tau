import { CustomEditor } from '@earendil-works/pi-coding-agent';
import type { AutocompleteProvider, EditorComponent } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';

import { editorParts } from './fixtures/editorParts.js';
import { selectedAutocompleteItem } from './preview.js';

const arrowDown = '\u001B[B';
const escape = '\u001B';

const notes = { value: '@notes.md', label: 'notes.md' };
const plan = { value: '@plan.md', label: 'plan.md' };

const fileProvider: AutocompleteProvider = {
  getSuggestions: async () => ({ items: [notes, plan], prefix: '@' }),
  applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

const openList = async () => {
  const editor = new CustomEditor(...editorParts());
  editor.setAutocompleteProvider(fileProvider);
  editor.handleInput('@');

  await vi.waitFor(() => {
    expect(editor.isShowingAutocomplete()).toBe(true);
  });

  return editor;
};

it('reads the selected item of the open list in the pi-tui editor', async () => {
  const editor = await openList();

  expect(selectedAutocompleteItem(editor)).toMatchObject(notes);

  editor.handleInput(arrowDown);

  expect(selectedAutocompleteItem(editor)).toMatchObject(plan);
});

it('reads no item after the list closes', async () => {
  const editor = await openList();

  editor.handleInput(escape);

  expect(selectedAutocompleteItem(editor)).toBeUndefined();
});

it('reads no item from an editor without a pi-tui autocomplete list', () => {
  const editor: EditorComponent = {
    getText: () => '',
    setText: () => {},
    handleInput: () => {},
    render: () => [],
    invalidate: () => {},
  };

  const withoutSelection = { ...editor, autocompleteList: {} } as EditorComponent;

  expect(selectedAutocompleteItem(editor)).toBeUndefined();
  expect(selectedAutocompleteItem(withoutSelection)).toBeUndefined();
});
