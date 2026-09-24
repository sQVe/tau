import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import snippetsExtension from './index.js';
import { openSnippetMenu } from './menu.js';
import { loadSnippets } from './snippet.js';
import type * as snippetModule from './snippet.js';
import type { Snippet } from './types.js';

vi.mock('./snippet.js', async (importOriginal) => ({
  ...(await importOriginal<typeof snippetModule>()),
  loadSnippets: vi.fn<typeof loadSnippets>(),
}));
vi.mock('./menu.js', () => ({ openSnippetMenu: vi.fn<typeof openSnippetMenu>() }));

const snippet: Snippet = {
  id: 'review.md',
  name: 'Review',
  description: 'Ask for a review.',
  placement: 'prepend',
  order: 1,
  body: 'Review this.',
};

const setup = async () => {
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const commands = new Map<string, (arguments_: string, context: ExtensionContext) => unknown>();
  snippetsExtension({
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    registerCommand: (
      name: string,
      command: { handler: (arguments_: string, context: ExtensionContext) => unknown },
    ) => commands.set(name, command.handler),
    registerShortcut: () => {},
  } as unknown as ExtensionAPI);
  const ui = {
    notify: vi.fn<ExtensionContext['ui']['notify']>(),
    setEditorText: vi.fn<ExtensionContext['ui']['setEditorText']>(),
    setWidget: vi.fn<ExtensionContext['ui']['setWidget']>(),
    theme: { fg: (_color: string, text: string) => text },
  };
  const context = { mode: 'tui', model: {}, ui } as unknown as ExtensionContext;

  vi.mocked(loadSnippets).mockResolvedValueOnce([snippet]);
  vi.mocked(openSnippetMenu).mockResolvedValueOnce(new Set([snippet.id]));
  await commands.get('snippets')?.('', context);

  const send = (text: string) => handlers.get('input')?.({ text }, context);

  return { ui, send };
};

it.for([
  {
    problem: 'Snippets could not be read',
    reload: () => vi.mocked(loadSnippets).mockRejectedValueOnce(new Error('EACCES')),
  },
  {
    problem: 'Snippets missing',
    reload: () => vi.mocked(loadSnippets).mockResolvedValueOnce([]),
  },
])('keeps the message and sends nothing when $problem', async ({ problem, reload }) => {
  const { ui, send } = await setup();
  reload();

  const result = await send('Ship it.');

  expect(result).toEqual({ action: 'handled' });
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(problem), 'error');
  expect(ui.setEditorText).toHaveBeenCalledWith('Ship it.');
});
