import { fileURLToPath } from 'node:url';

import { CustomEditor } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import type { EditorComponent } from '@earendil-works/pi-tui';

import { errorMessage } from '../../errors.js';
import { snippetAutocomplete } from './autocomplete.js';
import {
  historyRecord,
  readSnippetHistory,
  rememberTypedText,
  sentPromptTexts,
  snippetHistoryType,
  typedTextFor,
} from './history.js';
import { loadSnippets } from './snippet.js';
import { activeSnippets, expandSnippets, mayHoldTokens } from './tokens.js';
import type { Snippet } from './types.js';

interface SnippetsState {
  // Autocomplete and the widget read this on every keystroke. Sends reload it from disk.
  snippets: Snippet[];
  history: Map<string, string>;
}

const snippetsDirectory = fileURLToPath(new URL('./snippets/', import.meta.url));
const widgetKey = 'prompt-snippets';

const updateWidget = (state: SnippetsState, context: ExtensionContext, text: string): void => {
  const names = activeSnippets(text, state.snippets).map((snippet) => snippet.name);

  if (names.length === 0) {
    context.ui.setWidget(widgetKey, undefined);

    return;
  }

  context.ui.setWidget(widgetKey, [context.ui.theme.fg('accent', names.join(' · '))]);
};

// Pi assigns onChange after the factory returns, and an earlier editor may
// already intercept it. Wrap whichever handler ends up assigned.
const listenForChanges = (editor: EditorComponent, listener: (text: string) => void): void => {
  const earlier = Object.getOwnPropertyDescriptor(editor, 'onChange');
  const readEarlier: (() => typeof onChange) | undefined = earlier?.get?.bind(editor);
  let onChange = editor.onChange;

  const change = (text: string) => {
    listener(text);

    const next = readEarlier?.() ?? onChange;

    next?.(text);
  };

  Object.defineProperty(editor, 'onChange', {
    configurable: true,
    get: () => change,
    set: (handler: typeof onChange) => {
      earlier?.set?.call(editor, handler);
      onChange = handler;
    },
  });
};

// Pi fills history from stored messages, which hold the expanded snippet
// bodies. Store the text the user typed instead.
const restoreTypedHistory = (editor: EditorComponent, state: SnippetsState): void => {
  const addToHistory = editor.addToHistory?.bind(editor);

  if (addToHistory === undefined) {
    return;
  }

  editor.addToHistory = (text: string) => {
    addToHistory(typedTextFor(state.history, text) ?? text);
  };
};

const installEditor = (
  state: SnippetsState,
  context: ExtensionContext,
  sentHistory: string[],
): void => {
  const previous = context.ui.getEditorComponent();

  context.ui.setEditorComponent((terminalUI, theme, keybindings) => {
    const editor =
      previous?.(terminalUI, theme, keybindings) ??
      new CustomEditor(terminalUI, theme, keybindings, { embedWorkingStatus: true });

    listenForChanges(editor, (text) => {
      updateWidget(state, context, text);
    });

    restoreTypedHistory(editor, state);

    for (const text of sentHistory) {
      editor.addToHistory?.(text);
    }

    return editor;
  });
};

// On resume and fork, Pi fills history into its default editor before
// session_start, and the editor installed here does not copy it. On startup
// and tree navigation Pi fills the installed editor itself.
const sentHistoryFor = (reason: SessionStartEvent['reason'], context: ExtensionContext) =>
  reason === 'resume' || reason === 'fork' || reason === 'reload'
    ? sentPromptTexts(context.sessionManager.buildContextEntries())
    : [];

const handleSessionStart = async (
  state: SnippetsState,
  context: ExtensionContext,
  event: SessionStartEvent,
) => {
  state.history = readSnippetHistory(context.sessionManager.getEntries());

  if (context.mode !== 'tui') {
    return;
  }

  installEditor(state, context, sentHistoryFor(event.reason, context));
  context.ui.addAutocompleteProvider(snippetAutocomplete(() => state.snippets));

  try {
    state.snippets = await loadSnippets(snippetsDirectory);
  } catch (error) {
    context.ui.notify(`Snippets could not be read: ${errorMessage(error)}`, 'warning');
  }

  updateWidget(state, context, context.ui.getEditorText());
};

// Keep the typed message in the editor so the user can retry after fixing the snippets.
const stopSend = (context: ExtensionContext, text: string, detail: string) => {
  context.ui.notify(`Snippets could not be read, so nothing was sent: ${detail}`, 'error');

  if (context.mode === 'tui') {
    context.ui.setEditorText(text);
  }

  return { action: 'handled' as const };
};

// Reload snippets on every send so edits apply without reloading Pi.
const handleInput = async (
  pi: ExtensionAPI,
  state: SnippetsState,
  context: ExtensionContext,
  event: InputEvent,
): Promise<InputEventResult | undefined> => {
  if (!mayHoldTokens(event.text)) {
    return undefined;
  }

  // Pi catches errors thrown here and sends the message unchanged, so a read
  // failure must stop the send itself.
  try {
    state.snippets = await loadSnippets(snippetsDirectory);
  } catch (error) {
    return stopSend(context, event.text, errorMessage(error));
  }

  const sent = expandSnippets(event.text, state.snippets);

  if (sent === undefined) {
    return undefined;
  }

  const record = historyRecord(sent, event.text);

  pi.appendEntry(snippetHistoryType, record);
  rememberTypedText(state.history, record);

  return { action: 'transform' as const, text: sent };
};

export default function snippetsExtension(pi: ExtensionAPI) {
  const state: SnippetsState = { snippets: [], history: new Map() };

  pi.on('session_start', (event, context) => handleSessionStart(state, context, event));

  pi.on('input', (event, context) => handleInput(pi, state, context, event));
}
