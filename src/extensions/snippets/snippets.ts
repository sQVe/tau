import { fileURLToPath } from 'node:url';

import { CustomEditor, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { snippetAutocomplete } from './autocomplete.js';
import { refillsHistory, sentPromptTexts } from './history.js';
import { showPreview, watchSelectedItem } from './preview.js';
import { loadSnippets } from './snippet.js';
import type { Snippet } from './snippet.js';

const snippetsDirectory = fileURLToPath(new URL('./snippets/', import.meta.url));

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
