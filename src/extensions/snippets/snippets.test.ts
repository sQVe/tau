import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  InputEventResult,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteProvider, EditorComponent } from '@earendil-works/pi-tui';
import { beforeEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { historyRecord, readSnippetHistory, snippetHistoryType } from './history.js';
import { loadSnippets } from './snippet.js';
import snippetsExtension from './snippets.js';
import type { Snippet } from './types.js';

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext['getEditorComponent']>>;

vi.mock(import('./snippet.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  loadSnippets: vi.fn<typeof loadSnippets>(),
}));

const pushBack: Snippet = {
  id: 'push-back',
  name: 'Push back',
  description: 'Challenge the plan.',
  order: 1,
  body: 'Push back first.',
};

const simplify: Snippet = {
  id: 'simplify',
  name: 'Simplify',
  description: 'Prefer less code.',
  order: 1,
  body: 'Keep it simple.',
};

const customEntry = (data: unknown): SessionEntry => ({
  type: 'custom',
  customType: snippetHistoryType,
  data,
  id: 'saved',
  parentId: null,
  timestamp: '2026-10-01T12:00:00.000Z',
});

const createFakeEditor = () => {
  const history: string[] = [];

  const editor = {
    onChange: undefined as ((text: string) => void) | undefined,
    addToHistory: (text: string) => {
      history.push(text);
    },
    getText: () => '',
    setText: () => {},
    render: () => [],
    handleInput: () => {},
    invalidate: () => {},
  };

  return { editor: editor as unknown as EditorComponent, history };
};

beforeEach(() => {
  vi.mocked(loadSnippets).mockReset();
  vi.mocked(loadSnippets).mockResolvedValue([pushBack, simplify]);
});

const userEntry = (id: string, text: string): SessionEntry => ({
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
  id,
  parentId: null,
  timestamp: '2026-10-01T12:00:00.000Z',
});

const setup = async (entries: SessionEntry[] = [], reason = 'startup') => {
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>();
  const fake = fakeExtensionApi({ appendEntry });
  snippetsExtension(fake.pi);

  const { editor: innerEditor, history } = createFakeEditor();
  const editorFactories: EditorFactory[] = [];
  const autocompleteFactories: AutocompleteProviderFactory[] = [];
  const widgets: (string[] | undefined)[] = [];

  const ui = {
    notify: vi.fn<ExtensionContext['ui']['notify']>(),
    setEditorText: vi.fn<ExtensionContext['ui']['setEditorText']>(),
    getEditorText: () => '',
    setWidget: (_key: string, content: string[] | undefined) => {
      widgets.push(content);
    },
    getEditorComponent: () => () => innerEditor,
    setEditorComponent: (factory: EditorFactory) => {
      editorFactories.push(factory);
    },
    addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
      autocompleteFactories.push(factory);
    },
    theme: { fg: (_color: string, text: string) => text },
  };

  const context = {
    mode: 'tui',
    ui,
    sessionManager: { getEntries: () => entries, buildContextEntries: () => entries },
  } as unknown as ExtensionContext;

  await fake.handler('session_start')({ type: 'session_start', reason }, context);

  const send = async (text: string) =>
    (await fake.handler('input')({ type: 'input', text }, context)) as InputEventResult | undefined;

  // Pi builds the editor from the factory and then assigns its own callbacks.
  const buildEditor = () => {
    const editor = editorFactories.at(-1)!(...([] as unknown as Parameters<EditorFactory>));
    const piChanges: string[] = [];

    editor.onChange = (text: string) => {
      piChanges.push(text);
    };

    return { editor, piChanges };
  };

  return { ui, send, appendEntry, buildEditor, history, widgets, autocompleteFactories };
};

it('replaces each token with its snippet body where it stands', async () => {
  const { send } = await setup();

  expect(await send('#simplify Ship #push-back it.')).toEqual({
    action: 'transform',
    text: 'Keep it simple.\n\nShip\n\nPush back first.\n\nit.',
  });
});

it('sends a message that holds only tokens', async () => {
  const { send } = await setup();

  expect(await send('#push-back')).toEqual({ action: 'transform', text: 'Push back first.' });
});

it.each(['/skill:commit #push-back', 'Fix #123.', 'Ship it.'])(
  'sends %s unchanged without a history record',
  async (text) => {
    const { send, appendEntry } = await setup();

    expect(await send(text)).toBeUndefined();
    expect(appendEntry).not.toHaveBeenCalled();
  },
);

it('keeps the message and sends nothing when snippets cannot be read', async () => {
  const { ui, send, appendEntry } = await setup();
  vi.mocked(loadSnippets).mockRejectedValueOnce(new Error('EACCES'));

  const result = await send('#push-back Ship it.');

  expect(result).toEqual({ action: 'handled' });
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('EACCES'), 'error');
  expect(ui.setEditorText).toHaveBeenCalledWith('#push-back Ship it.');
  expect(appendEntry).not.toHaveBeenCalled();
});

it('uses snippets added to disk after the session started', async () => {
  const { send } = await setup();
  const added = { ...simplify, id: 'added', body: 'Added body.' };
  vi.mocked(loadSnippets).mockResolvedValueOnce([added]);

  expect(await send('#added Ship it.')).toEqual({
    action: 'transform',
    text: 'Added body.\n\nShip it.',
  });
});

it('saves a record that maps the sent text to the typed text', async () => {
  const { send, appendEntry } = await setup();

  await send('#push-back Ship it.');

  expect(appendEntry).toHaveBeenCalledOnce();

  const [customType, data] = appendEntry.mock.calls[0]!;
  const history = readSnippetHistory([customEntry(data)]);

  expect(customType).toBe(snippetHistoryType);
  expect(history.size).toBe(1);
});

it('adds the typed text to history in place of a saved sent text', async () => {
  const sent = 'Push back first.\n\nShip it.';
  const saved = customEntry(historyRecord(sent, '#push-back Ship it.'));
  const { buildEditor, history } = await setup([saved]);
  const { editor } = buildEditor();

  editor.addToHistory?.(sent);
  editor.addToHistory?.('Plain message.');

  expect(history).toEqual(['#push-back Ship it.', 'Plain message.']);
});

it.each([
  { reason: 'resume', seeded: ['#push-back Ship it.', 'Plain message.'] },
  { reason: 'fork', seeded: ['#push-back Ship it.', 'Plain message.'] },
  { reason: 'startup', seeded: [] },
  { reason: 'new', seeded: [] },
  { reason: 'reload', seeded: ['#push-back Ship it.', 'Plain message.'] },
])('seeds history with the typed text after $reason: $seeded', async ({ reason, seeded }) => {
  const sent = 'Push back first.\n\nShip it.';

  const entries = [
    userEntry('first', sent),
    customEntry(historyRecord(sent, '#push-back Ship it.')),
    userEntry('blank', ''),
    userEntry('second', 'Plain message.'),
  ];

  const { buildEditor, history } = await setup(entries, reason);

  buildEditor();

  expect(history).toEqual(seeded);
});

it('adds the typed text to history for a message sent in this session', async () => {
  const { send, buildEditor, history } = await setup();
  const { editor } = buildEditor();

  const result = await send('Ship it. #simplify');

  if (result?.action !== 'transform') {
    throw new Error('Expected a transformed message.');
  }

  editor.addToHistory?.(result.text);

  expect(history).toEqual(['Ship it. #simplify']);
});

it('lists the snippet names of the editor text in token order and passes the change on', async () => {
  const { buildEditor, widgets } = await setup();
  const { editor, piChanges } = buildEditor();

  editor.onChange?.('#simplify Ship #push-back it.');

  expect(widgets.at(-1)).toEqual([expect.stringMatching(/Simplify.*Push back/)]);

  editor.onChange?.('Ship it.');

  expect(widgets.at(-1)).toBeUndefined();
  expect(piChanges).toEqual(['#simplify Ship #push-back it.', 'Ship it.']);
});

it('shows no snippets for a slash command', async () => {
  const { buildEditor, widgets } = await setup();
  const { editor } = buildEditor();

  editor.onChange?.('/skill:commit #simplify');

  expect(widgets.at(-1)).toBeUndefined();
});

it('suggests the snippets loaded at session start', async () => {
  const { autocompleteFactories } = await setup();

  const wrapped: AutocompleteProvider = {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  };

  const provider = autocompleteFactories[0]!(wrapped);
  const signal = new AbortController().signal;
  const suggestions = await provider.getSuggestions(['#simp'], 0, 5, { signal });

  expect(suggestions?.items.map((item) => item.value)).toEqual(['#simplify']);
});
