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

  const updateWidget = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') {
      return;
    }

    const active = snippets.filter((snippet) => enabled.has(snippet.id));
    const names = (placement: string) =>
      active
        .filter((snippet) => snippet.placement === placement)
        .map((snippet) => snippet.name)
        .join(' · ');
    const prepended = names('prepend');
    const appended = names('append');

    if (prepended === '' && appended === '') {
      ctx.ui.setWidget(widgetKey, undefined);
      return;
    }

    ctx.ui.setWidget(widgetKey, [
      ...(prepended === '' ? [] : [ctx.ui.theme.fg('accent', `↑ prepend: ${prepended}`)]),
      ...(appended === '' ? [] : [ctx.ui.theme.fg('warning', `↓ append: ${appended}`)]),
    ]);
  };

  const openMenu = async (ctx: ExtensionContext) => {
    // The menu is a terminal component, so it needs TUI mode rather than any
    // UI. `hasUI` is also true in RPC mode, where `ui.custom` never runs a
    // component and resolves undefined, which would look like a cancel.
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('The snippet menu needs the terminal UI.', 'warning');
      return;
    }

    snippets = await loadSnippets(snippetsDirectory);
    if (snippets.length === 0) {
      ctx.ui.notify(`No snippets found in ${snippetsDirectory}`, 'warning');
      updateWidget(ctx);
      return;
    }

    const selected = await openSnippetMenu(ctx, snippets, enabled);
    if (selected !== null) {
      enabled = selected;
    }

    updateWidget(ctx);
  };

  pi.on('session_start', async (_event, ctx) => {
    enabled = new Set();
    snippets = await loadSnippets(snippetsDirectory);
    updateWidget(ctx);
  });

  // Snippets are re-read on every send, so edits apply without reloading pi.
  pi.on('input', async (event, ctx) => {
    // Pi validates the model after this handler returns and throws when none is
    // selected. Spending the toggles here would lose them on a send that never
    // happened, so leave them for the retry.
    if (enabled.size === 0 || !acceptsSnippets(event.text) || ctx.model === undefined) {
      return undefined;
    }

    // Pi catches errors thrown here and sends the message unchanged, so a read
    // failure has to stop the send itself. The toggles stay on for the retry.
    let loaded: Snippet[];
    try {
      loaded = await loadSnippets(snippetsDirectory);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Snippets could not be read, so nothing was sent: ${reason}`, 'error');
      if (ctx.mode === 'tui') {
        ctx.ui.setEditorText(event.text);
      }

      return { action: 'handled' as const };
    }

    snippets = loaded;
    const active = snippets.filter((snippet) => enabled.has(snippet.id));
    enabled = new Set();
    updateWidget(ctx);

    // Every selected snippet was deleted while the message was being typed.
    if (active.length === 0) {
      return undefined;
    }

    return { action: 'transform' as const, text: buildSnippetMessage(event.text, active) };
  });

  pi.registerShortcut('alt+s', {
    description: 'Toggle prompt snippets',
    handler: openMenu,
  });

  pi.registerCommand('snippets', {
    description: 'Open the prompt snippet toggle menu.',
    handler: (_args, ctx) => openMenu(ctx),
  });
}
