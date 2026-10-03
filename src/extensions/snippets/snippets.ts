import { fileURLToPath } from 'node:url';

import { CustomEditor, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { AutocompleteItem, Component } from '@earendil-works/pi-tui';

import { bottomBorder, boxFrameWidth, boxLine, topBorder } from '../../box.js';
import { errorMessage } from '../../errors.js';
import { snippetAutocomplete, snippetForItem } from './autocomplete.js';
import { refillsHistory, sentPromptTexts } from './history.js';
import { watchSelectedItem } from './preview.js';
import { loadSnippets } from './snippet.js';
import type { Snippet } from './types.js';

const snippetsDirectory = fileURLToPath(new URL('./snippets/', import.meta.url));
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
const showPreview = (context: ExtensionContext, readSnippets: () => Snippet[]) => {
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

const sentHistoryFor = (reason: SessionStartEvent['reason'], context: ExtensionContext) => {
  if (!refillsHistory(reason)) {
    return [];
  }

  const messages = context.sessionManager
    .buildContextEntries()
    .flatMap((entry) => sessionEntryToContextMessages(entry));

  return sentPromptTexts(messages);
};

const installEditor = (
  context: ExtensionContext,
  readSnippets: () => Snippet[],
  sentHistory: string[],
): void => {
  const previous = context.ui.getEditorComponent();

  context.ui.setEditorComponent((terminalUI, theme, keybindings) => {
    const editor =
      previous?.(terminalUI, theme, keybindings) ??
      new CustomEditor(terminalUI, theme, keybindings, { embedWorkingStatus: true });

    watchSelectedItem(editor, showPreview(context, readSnippets));

    for (const text of sentHistory) {
      editor.addToHistory?.(text);
    }

    return editor;
  });
};

const handleSessionStart = async (context: ExtensionContext, event: SessionStartEvent) => {
  if (context.mode !== 'tui') {
    return;
  }

  // Autocomplete and the preview read this list on every keystroke, so it is loaded once per
  // session.
  let snippets: Snippet[] = [];
  const readSnippets = () => snippets;

  installEditor(context, readSnippets, sentHistoryFor(event.reason, context));
  context.ui.addAutocompleteProvider(snippetAutocomplete(readSnippets));

  try {
    snippets = await loadSnippets(snippetsDirectory);
  } catch (error) {
    context.ui.notify(`Snippets could not be read: ${errorMessage(error)}`, 'warning');
  }
};

export default function snippetsExtension(pi: ExtensionAPI): void {
  pi.on('session_start', (event, context) => handleSessionStart(context, event));
}
