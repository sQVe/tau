import type {
  AutocompleteProviderFactory,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';
import { beforeEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { loadSnippets } from './snippet.js';
import snippetsExtension from './snippets.js';
import type { Snippet } from './types.js';

vi.mock(import('./snippet.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  loadSnippets: vi.fn<typeof loadSnippets>(),
}));

const simplify: Snippet = {
  id: 'simplify',
  name: 'Simplify',
  description: 'Prefer less code.',
  order: 1,
  body: 'Keep it simple.',
};

const wrapped: AutocompleteProvider = {
  getSuggestions: async () => null,
  applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

beforeEach(() => {
  vi.mocked(loadSnippets).mockReset();
  vi.mocked(loadSnippets).mockResolvedValue([simplify]);
});

const startSession = async (mode: ExtensionContext['mode']) => {
  const fake = fakeExtensionApi();
  snippetsExtension(fake.pi);

  const autocompleteFactories: AutocompleteProviderFactory[] = [];
  const notify = vi.fn<ExtensionContext['ui']['notify']>();

  const ui = {
    notify,
    addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
      autocompleteFactories.push(factory);
    },
  };

  const context = { mode, ui } as unknown as ExtensionContext;

  await fake.handler('session_start')({ type: 'session_start', reason: 'startup' }, context);

  return { autocompleteFactories, notify };
};

const suggestedValues = async (factory: AutocompleteProviderFactory | undefined) => {
  const provider = factory?.(wrapped);
  const signal = new AbortController().signal;
  const suggestions = await provider?.getSuggestions(['#'], 0, 1, { signal });

  return suggestions?.items.map((item) => item.value);
};

it('suggests the snippets loaded at session start', async () => {
  const { autocompleteFactories, notify } = await startSession('tui');

  expect(await suggestedValues(autocompleteFactories[0])).toEqual(['#simplify']);
  expect(notify).not.toHaveBeenCalled();
});

it('warns and suggests nothing when snippets cannot be read', async () => {
  vi.mocked(loadSnippets).mockRejectedValue(new Error('EACCES'));

  const { autocompleteFactories, notify } = await startSession('tui');

  expect(notify).toHaveBeenCalledWith(expect.stringContaining('EACCES'), 'warning');
  expect(await suggestedValues(autocompleteFactories[0])).toBeUndefined();
});

it('adds no autocomplete outside the terminal UI', async () => {
  const { autocompleteFactories } = await startSession('rpc');

  expect(autocompleteFactories).toEqual([]);
  expect(loadSnippets).not.toHaveBeenCalled();
});
