import type { AutocompleteItem, EditorComponent } from '@earendil-works/pi-tui';

import { isRecord } from '../../tauConfig.js';

interface SelectedItemSource {
  getSelectedItem: () => AutocompleteItem | null;
}

const isSelectedItemSource = (value: unknown): value is SelectedItemSource =>
  isRecord(value) && typeof value['getSelectedItem'] === 'function';

/**
 * The selected item of the editor's open autocomplete list. pi-tui keeps the
 * list in the private `autocompleteList` field, so an editor without that
 * field has no selected item.
 */
export const selectedAutocompleteItem = (editor: EditorComponent): AutocompleteItem | undefined => {
  const list = 'autocompleteList' in editor ? editor.autocompleteList : undefined;

  if (!isSelectedItemSource(list)) {
    return undefined;
  }

  return list.getSelectedItem() ?? undefined;
};

/**
 * Calls `listener` with the selected autocomplete item after each render.
 * Suggestions arrive after a debounce and an async provider, so no key press
 * marks when the list changes. pi-tui renders the editor after each change.
 */
export const watchSelectedItem = (
  editor: EditorComponent,
  listener: (item: AutocompleteItem | undefined) => void,
): void => {
  const render = editor.render.bind(editor);

  editor.render = (width) => {
    const lines = render(width);

    listener(selectedAutocompleteItem(editor));

    return lines;
  };
};
