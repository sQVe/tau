import { fileURLToPath } from 'node:url';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { openSnippetMenu } from './menu.js';
import { acceptsSnippets, buildSnippetMessage, loadSnippets } from './snippet.js';
import type { Snippet } from './types.js';

const snippetsDirectory = fileURLToPath(new URL('./snippets/', import.meta.url));
const widgetKey = 'prompt-snippets';

export default function snippetsExtension(pi: ExtensionAPI) {
  let snippets: Snippet[] = [];
  let enabled = new Set<string>();

  const updateWidget = (context: ExtensionContext) => {
    if (context.mode !== 'tui') {
      return;
    }

    const active = snippets.filter((snippet) => enabled.has(snippet.id));
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

    context.ui.setWidget(widgetKey, [
      ...(prepended === '' ? [] : [context.ui.theme.fg('accent', `↑ prepend: ${prepended}`)]),
      ...(appended === '' ? [] : [context.ui.theme.fg('warning', `↓ append: ${appended}`)]),
    ]);
  };

  const openMenu = async (context: ExtensionContext) => {
    // `hasUI` is also true in RPC mode, where `ui.custom` returns undefined
    // without running a component. The menu needs TUI mode.
    if (context.mode !== 'tui') {
      context.ui.notify('The snippet menu needs the terminal UI.', 'warning');

      return;
    }

    try {
      snippets = await loadSnippets(snippetsDirectory);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      context.ui.notify(`Snippets could not be read: ${reason}`, 'error');

      return;
    }

    if (snippets.length === 0) {
      context.ui.notify(`No snippets found in ${snippetsDirectory}`, 'warning');
      updateWidget(context);

      return;
    }

    const selected = await openSnippetMenu(context, snippets, enabled);

    if (selected !== null) {
      enabled = selected;
    }

    updateWidget(context);
  };

  // Every reader reloads from disk first, so there is nothing to load here.
  const resetToggles = (context: ExtensionContext) => {
    enabled = new Set();

    updateWidget(context);
  };

  pi.on('session_start', (_event, context) => {
    resetToggles(context);
  });

  pi.on('session_before_switch', (_event, context) => {
    resetToggles(context);

    return undefined;
  });

  pi.on('session_before_fork', (_event, context) => {
    resetToggles(context);

    return undefined;
  });

  // Reload snippets on every send so edits apply without reloading Pi.
  pi.on('input', async (event, context) => {
    // Pi validates the model after this handler returns and throws when none is
    // selected. Keep the toggles for a retry rather than losing them on a failed send.
    if (enabled.size === 0 || !acceptsSnippets(event.text) || context.model === undefined) {
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

    snippets = loaded;
    const active = snippets.filter((snippet) => enabled.has(snippet.id));

    // Deleted or invalid files drop out of `active` without throwing. Stop the
    // send rather than omit an instruction the user selected.
    if (active.length < enabled.size) {
      const missing = [...enabled].filter((id) => !active.some((snippet) => snippet.id === id));

      context.ui.notify(`Snippets missing, so nothing was sent: ${missing.join(', ')}`, 'error');

      if (context.mode === 'tui') {
        context.ui.setEditorText(event.text);
      }

      return { action: 'handled' as const };
    }

    enabled = new Set();
    updateWidget(context);

    return { action: 'transform' as const, text: buildSnippetMessage(event.text, active) };
  });

  // Ctrl+q reaches the app because Pi's raw mode turns off terminal flow control.
  pi.registerShortcut('ctrl+q', {
    description: 'Toggle prompt snippets',
    handler: openMenu,
  });

  pi.registerCommand('snippets', {
    description: 'Open the prompt snippet toggle menu.',
    handler: (_arguments, context) => openMenu(context),
  });
}
