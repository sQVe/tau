import { fileURLToPath } from 'node:url';

import { CustomEditor } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from '@earendil-works/pi-coding-agent';

import { openSnippetMenu } from './menu.js';
import { acceptsSnippets, buildSnippetMessage, loadSnippets } from './snippet.js';
import type { Snippet } from './types.js';

const snippetsDirectory = fileURLToPath(new URL('./snippets/', import.meta.url));
const widgetKey = 'prompt-snippets';

interface SnippetsState {
  snippets: Snippet[];
  enabled: Set<string>;
}

const updateWidget = (state: SnippetsState, context: ExtensionContext): void => {
  if (context.mode !== 'tui') {
    return;
  }

  const active = state.snippets.filter((snippet) => state.enabled.has(snippet.id));
  const namesForPlacement = (placement: string) =>
    active
      .filter((snippet) => snippet.placement === placement)
      .map((snippet) => snippet.name)
      .join(' · ');

  const prepended = namesForPlacement('prepend');
  const appended = namesForPlacement('append');

  if (prepended === '' && appended === '') {
    context.ui.setWidget(widgetKey, undefined);

    return;
  }

  const lines: string[] = [];

  if (prepended !== '') {
    lines.push(context.ui.theme.fg('accent', `↑ prepend: ${prepended}`));
  }

  if (appended !== '') {
    lines.push(context.ui.theme.fg('warning', `↓ append: ${appended}`));
  }

  context.ui.setWidget(widgetKey, lines);
};

const openMenu = async (state: SnippetsState, context: ExtensionContext): Promise<void> => {
  // `hasUI` is also true in RPC mode, where `ui.custom` returns undefined
  // without running a component. The menu needs TUI mode.
  if (context.mode !== 'tui') {
    context.ui.notify('The snippet menu needs the terminal UI.', 'warning');

    return;
  }

  try {
    state.snippets = await loadSnippets(snippetsDirectory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    context.ui.notify(`Snippets could not be read: ${reason}`, 'error');

    return;
  }

  if (state.snippets.length === 0) {
    context.ui.notify(`No snippets found in ${snippetsDirectory}`, 'warning');
    updateWidget(state, context);

    return;
  }

  const selected = await openSnippetMenu(context, state.snippets, state.enabled);

  if (selected !== null) {
    state.enabled = selected;
  }

  updateWidget(state, context);
};

// Every reader reloads from disk first, so there is nothing to load here.
const resetToggles = (state: SnippetsState, context: ExtensionContext): void => {
  state.enabled = new Set();

  updateWidget(state, context);
};

const installEditor = (pi: ExtensionAPI, state: SnippetsState, context: ExtensionContext): void => {
  const previous = context.ui.getEditorComponent();

  context.ui.setEditorComponent((terminalUI, theme, keybindings) => {
    const editor =
      previous?.(terminalUI, theme, keybindings) ??
      new CustomEditor(terminalUI, theme, keybindings, { embedWorkingStatus: true });
    const earlier = Object.getOwnPropertyDescriptor(editor, 'onSubmit');
    const readEarlier: (() => typeof onSubmit) | undefined = earlier?.get?.bind(editor);
    let onSubmit = editor.onSubmit;
    const submit = (text: string) => {
      if (text.trim() === '' && state.enabled.size > 0) {
        pi.sendUserMessage('', { deliverAs: 'steer' });

        return;
      }

      const next = readEarlier?.() ?? onSubmit;

      next?.(text);
    };

    // Pi assigns onSubmit after the factory returns. Intercept submissions,
    // not keys, so paste, autocomplete, and disabled submission still work.
    Object.defineProperty(editor, 'onSubmit', {
      configurable: true,
      get: () => submit,
      set: (handler: typeof onSubmit) => {
        earlier?.set?.call(editor, handler);
        onSubmit = handler;
      },
    });

    return editor;
  });
};

const handleSessionStart = (
  pi: ExtensionAPI,
  state: SnippetsState,
  context: ExtensionContext,
): void => {
  resetToggles(state, context);

  if (context.mode !== 'tui') {
    return;
  }

  installEditor(pi, state, context);
};

// Reload snippets on every send so edits apply without reloading Pi.
const handleInput = async (
  state: SnippetsState,
  context: ExtensionContext,
  event: InputEvent,
): Promise<InputEventResult | undefined> => {
  // Pi validates the model after this handler returns and throws when none is
  // selected. Keep the toggles for a retry rather than losing them on a failed send.
  if (state.enabled.size === 0 || !acceptsSnippets(event.text) || context.model === undefined) {
    return undefined;
  }

  // Pi catches errors thrown here and sends the message unchanged, so a read
  // failure must stop the send itself. The toggles stay on for the retry.
  let loaded: Snippet[];

  try {
    loaded = await loadSnippets(snippetsDirectory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    context.ui.notify(`Snippets could not be read, so nothing was sent: ${reason}`, 'error');

    if (context.mode === 'tui') {
      context.ui.setEditorText(event.text);
    }

    return { action: 'handled' as const };
  }

  state.snippets = loaded;
  const active = state.snippets.filter((snippet) => state.enabled.has(snippet.id));

  // Deleted or invalid files drop out of `active` without throwing. Stop the
  // send rather than omit an instruction the user selected.
  if (active.length < state.enabled.size) {
    const missing = [...state.enabled].filter((id) => !active.some((snippet) => snippet.id === id));

    context.ui.notify(`Snippets missing, so nothing was sent: ${missing.join(', ')}`, 'error');

    if (context.mode === 'tui') {
      context.ui.setEditorText(event.text);
    }

    return { action: 'handled' as const };
  }

  state.enabled = new Set();
  updateWidget(state, context);

  return { action: 'transform' as const, text: buildSnippetMessage(event.text, active) };
};

export default function snippetsExtension(pi: ExtensionAPI) {
  const state: SnippetsState = { snippets: [], enabled: new Set() };

  pi.on('session_start', (_event, context) => {
    handleSessionStart(pi, state, context);
  });

  pi.on('session_before_switch', (_event, context) => {
    resetToggles(state, context);

    return undefined;
  });

  pi.on('session_before_fork', (_event, context) => {
    resetToggles(state, context);

    return undefined;
  });

  pi.on('input', (event, context) => handleInput(state, context, event));

  // Ctrl+q reaches the app because Pi's raw mode turns off terminal flow control.
  pi.registerShortcut('ctrl+q', {
    description: 'Toggle prompt snippets',
    handler: (context) => openMenu(state, context),
  });

  pi.registerCommand('snippets', {
    description: 'Open the prompt snippet toggle menu.',
    handler: (_arguments, context) => openMenu(state, context),
  });
}
