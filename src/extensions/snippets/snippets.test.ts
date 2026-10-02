import type {
  AutocompleteProviderFactory,
  ExtensionContext,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { AutocompleteProvider, EditorComponent } from '@earendil-works/pi-tui';
import { beforeEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { editorParts } from './fixtures/editorParts.js';
import { loadSnippets } from './snippet.js';
import snippetsExtension from './snippets.js';
import type { Snippet } from './types.js';

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext['getEditorComponent']>>;
type WidgetContent = Parameters<ExtensionUIContext['setWidget']>[1];
type WidgetTheme = Parameters<NonNullable<WidgetContent>>[1];

vi.mock(import('./snippet.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  loadSnippets: vi.fn<typeof loadSnippets>(),
}));

const arrowDown = '\u001B[B';
const arrowUp = '\u001B[A';
const escape = '\u001B';
const tab = '\t';

const simplify: Snippet = {
  id: 'simplify',
  name: 'Simplify',
  description: 'Prefer less code.',
  order: 1,
  body: 'Keep it simple.',
};

const review: Snippet = {
  id: 'review',
  name: 'Review',
  description: 'Check the change.',
  order: 2,
  body: 'Review the change.\n\nList each risk.',
};

const checklist: Snippet = {
  id: 'checklist',
  name: 'Checklist',
  description: 'Walk through each step.',
  order: 3,
  body: Array.from({ length: 12 }, (_, index) => `Step ${index + 1}.`).join('\n'),
};

const notesFile = { value: '@notes.md', label: 'notes.md' };

// Stands in for Pi's file suggestions after `@`.
const wrapped: AutocompleteProvider = {
  getSuggestions: async (lines, cursorLine) =>
    lines[cursorLine]?.includes('@') === true ? { items: [notesFile], prefix: '@' } : null,
  applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

beforeEach(() => {
  vi.mocked(loadSnippets).mockReset();
  vi.mocked(loadSnippets).mockResolvedValue([simplify, review, checklist]);
});

const startSession = async (mode: ExtensionContext['mode']) => {
  const fake = fakeExtensionApi();
  snippetsExtension(fake.pi);

  const autocompleteFactories: AutocompleteProviderFactory[] = [];
  const editorFactories: EditorFactory[] = [];
  const widgets: WidgetContent[] = [];
  const notify = vi.fn<ExtensionContext['ui']['notify']>();

  const ui = {
    notify,
    addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
      autocompleteFactories.push(factory);
    },
    getEditorComponent: () => editorFactories.at(-1),
    setEditorComponent: (factory: EditorFactory) => {
      editorFactories.push(factory);
    },
    setWidget: (_key: string, content: WidgetContent) => {
      widgets.push(content);
    },
  };

  const context = { mode, ui } as unknown as ExtensionContext;

  await fake.handler('session_start')({ type: 'session_start', reason: 'startup' }, context);

  return { autocompleteFactories, editorFactories, widgets, notify };
};

const suggestedValues = async (factory: AutocompleteProviderFactory | undefined) => {
  const provider = factory?.(wrapped);
  const signal = new AbortController().signal;
  const suggestions = await provider?.getSuggestions(['#'], 0, 1, { signal });

  return suggestions?.items.map((item) => item.value);
};

const widgetTheme = { fg: (_color: string, text: string) => text } as unknown as WidgetTheme;

// Renders a widget the way Pi renders one above the editor.
const renderedLines = (content: WidgetContent) => {
  const [terminalUI] = editorParts();

  const component = content?.(terminalUI, widgetTheme);

  return component?.render(80);
};

// The text inside the box frame, without the frame and the padding after each line.
const boxBody = (lines: string[] | undefined) =>
  lines?.slice(1, -1).map((line) => line.slice(2, -2).trimEnd());

// Builds the installed editor the way Pi does and renders a frame after each step.
const startEditor = async () => {
  const session = await startSession('tui');
  const factory = session.editorFactories.at(-1);
  const provider = session.autocompleteFactories[0]?.(wrapped);

  if (factory === undefined || provider === undefined) {
    throw new Error('The extension installed no editor or autocomplete.');
  }

  const editor = factory(...editorParts()) as EditorComponent & {
    isShowingAutocomplete: () => boolean;
  };

  editor.setAutocompleteProvider?.(provider);

  const press = (key: string) => {
    editor.handleInput(key);
    editor.render(80);
  };

  const type = (text: string) => {
    for (const character of text) {
      press(character);
    }
  };

  const typeUntilListed = async (text: string) => {
    type(text);

    await vi.waitFor(() => {
      expect(editor.isShowingAutocomplete()).toBe(true);
    });

    editor.render(80);
  };

  return {
    ...session,
    editor,
    press,
    type,
    typeUntilListed,
    preview: () => boxBody(renderedLines(session.widgets.at(-1))),
    frame: () => renderedLines(session.widgets.at(-1)),
  };
};

const bodyLines = (snippet: Snippet) => snippet.body.split('\n');

const words = (count: number) => Array.from({ length: count }, () => 'alpha').join(' ');

it('suggests the snippets loaded at session start', async () => {
  const { autocompleteFactories, notify } = await startSession('tui');

  expect(await suggestedValues(autocompleteFactories[0])).toEqual([
    '#simplify',
    '#review',
    '#checklist',
  ]);

  expect(notify).not.toHaveBeenCalled();
});

it('warns and suggests nothing when snippets cannot be read', async () => {
  vi.mocked(loadSnippets).mockRejectedValue(new Error('EACCES'));

  const { autocompleteFactories, notify } = await startSession('tui');

  expect(notify).toHaveBeenCalledWith(expect.stringContaining('EACCES'), 'warning');
  expect(await suggestedValues(autocompleteFactories[0])).toBeUndefined();
});

it('adds no autocomplete or editor outside the terminal UI', async () => {
  const { autocompleteFactories, editorFactories } = await startSession('rpc');

  expect(autocompleteFactories).toEqual([]);
  expect(editorFactories).toEqual([]);
  expect(loadSnippets).not.toHaveBeenCalled();
});

it('previews the body of the selected snippet and follows the selection', async () => {
  const harness = await startEditor();

  await harness.typeUntilListed('#');

  expect(harness.preview()).toEqual(bodyLines(simplify));

  harness.press(arrowDown);

  expect(harness.preview()).toEqual(bodyLines(review));

  harness.press(arrowUp);

  expect(harness.preview()).toEqual(bodyLines(simplify));
});

it('frames the preview in a box titled with the snippet name', async () => {
  const harness = await startEditor();

  await harness.typeUntilListed('#');
  const frame = harness.frame();

  expect(frame?.[0]).toBe(`╭ Simplify ${'─'.repeat(68)}╮`);
  expect(frame?.at(-1)).toBe(`╰${'─'.repeat(78)}╯`);
  expect(frame?.every((line) => visibleWidth(line) === 80)).toBe(true);
});

it('wraps a body line wider than the box instead of cutting it', async () => {
  const long: Snippet = { ...simplify, id: 'long', name: 'Long', body: `  ${words(20)}\n\nEnd.` };

  vi.mocked(loadSnippets).mockResolvedValue([long]);
  const harness = await startEditor();

  await harness.typeUntilListed('#');

  expect(harness.preview()).toEqual([`  ${words(12)}`, words(8), '', 'End.']);
});

it('updates the preview only when the selected snippet changes', async () => {
  const harness = await startEditor();

  await harness.typeUntilListed('#');
  const updates = harness.widgets.length;

  harness.editor.render(80);
  harness.editor.render(80);

  expect(harness.widgets).toHaveLength(updates);
});

it('previews the snippet that typing narrows the list to', async () => {
  const harness = await startEditor();

  await harness.typeUntilListed('#');
  harness.type('rev');

  await vi.waitFor(() => {
    harness.editor.render(80);
    expect(harness.preview()).toEqual(bodyLines(review));
  });
});

it('previews every line of a long snippet', async () => {
  const harness = await startEditor();

  await harness.typeUntilListed('#check');

  await vi.waitFor(() => {
    harness.editor.render(80);
    expect(harness.preview()).toEqual(bodyLines(checklist));
  });
});

it('clears the preview when the list closes', async () => {
  const harness = await startEditor();

  await harness.typeUntilListed('#');
  harness.press(escape);

  expect(harness.editor.isShowingAutocomplete()).toBe(false);
  expect(harness.preview()).toBeUndefined();
});

it('clears the preview after a pick', async () => {
  const harness = await startEditor();

  await harness.typeUntilListed('#');
  harness.press(tab);

  expect(harness.editor.getText()).toBe(simplify.body);
  expect(harness.preview()).toBeUndefined();
});

it('shows no preview for an item that is not a snippet', async () => {
  const harness = await startEditor();

  await harness.typeUntilListed('@');

  expect(harness.widgets.filter((content) => content !== undefined)).toEqual([]);
});
