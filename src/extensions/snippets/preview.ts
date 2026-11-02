import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { AutocompleteItem, Component, EditorComponent } from '@earendil-works/pi-tui';

import { bottomBorder, boxFrameWidth, boxLine, topBorder } from '../../dialog/box.js';
import { isRecord } from '../../schema.js';
import { snippetForItem } from './autocomplete.js';
import type { Snippet } from './snippet.js';

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

const widgetKey = 'snippet-preview';

const previewLines = (snippet: Snippet, width: number, theme: Theme) => {
  const innerWidth = Math.max(1, width - boxFrameWidth);

  const bodyLines = snippet.body
    .split('\n')
    .flatMap((line) => wrapTextWithAnsi(line, innerWidth))
    .map((line) => boxLine(theme.fg('muted', line), width, theme));

  return [
    topBorder(` ${snippet.name} `, '', width, theme),
    ...bodyLines,
    bottomBorder(width, theme),
  ];
};

const previewBox = (snippet: Snippet, theme: Theme): Component => ({
  render: (width) => previewLines(snippet, width, theme),
  invalidate() {
    // No render cache: each render draws the box at the current width.
  },
});

// Pi renders the editor on every frame, so the widget changes only when the
// previewed snippet does.
export const showPreview = (
  context: ExtensionContext,
  readSnippets: () => Snippet[],
): ((item: AutocompleteItem | undefined) => void) => {
  let shown: Snippet | undefined;

  return (item: AutocompleteItem | undefined) => {
    const snippet = item === undefined ? undefined : snippetForItem(readSnippets(), item);

    if (snippet === shown) {
      return;
    }

    shown = snippet;

    if (snippet === undefined) {
      context.ui.setWidget(widgetKey, undefined);

      return;
    }

    // Pi cuts a string array widget after ten lines, so a component shows the whole body.
    context.ui.setWidget(widgetKey, (_terminalUI, theme) => previewBox(snippet, theme));
  };
};
