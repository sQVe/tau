import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';

import { snippetAutocomplete } from './autocomplete.js';
import type { Snippet } from './types.js';

const createSnippet = (id: string, name: string, description: string): Snippet => ({
  id,
  name,
  description,
  order: 10,
  body: `${name}.`,
});

const snippets = [
  createSnippet('push-back', 'Push back', 'Challenge the plan'),
  createSnippet('verify-not-assume', "Verify, don't assume", 'Check facts first'),
  createSnippet('simplify', 'Simplify', 'Prefer less code'),
];

const wrappedItem: AutocompleteItem = { value: 'src/', label: 'src/' };

const createWrapped = () => {
  const wrapped = {
    getSuggestions: vi.fn<AutocompleteProvider['getSuggestions']>(async () => ({
      items: [wrappedItem],
      prefix: '@sr',
    })),
    applyCompletion: vi.fn<AutocompleteProvider['applyCompletion']>(() => ({
      lines: ['wrapped'],
      cursorLine: 0,
      cursorCol: 7,
    })),
  };

  return wrapped;
};

const options = { signal: new AbortController().signal };

const suggest = (lines: string[], cursorLine: number, cursorCol: number) => {
  const wrapped = createWrapped();
  const provider = snippetAutocomplete(() => snippets)(wrapped);

  return {
    wrapped,
    provider,
    result: provider.getSuggestions(lines, cursorLine, cursorCol, options),
  };
};

it('triggers on #', () => {
  const provider = snippetAutocomplete(() => snippets)(createWrapped());

  expect(provider.triggerCharacters).toEqual(['#']);
});

it('suggests snippets whose name or description match the query', async () => {
  const { result } = suggest(['Ship it #fact'], 0, 13);

  expect(await result).toEqual({
    items: [expect.objectContaining({ value: '#verify-not-assume' })],
    prefix: '#fact',
  });
});

it('finds a query on a later line', async () => {
  const { result } = suggest(['First line.', '#simp'], 1, 5);

  expect((await result)?.items.map((item) => item.value)).toEqual(['#simplify']);
});

it('inserts the token and a space in place of the query', () => {
  const { provider } = suggest(['#pu'], 0, 3);
  const item = { value: '#push-back', label: 'Push back' };

  const result = provider.applyCompletion(['Ship it.', '#pu'], 1, 3, item, '#pu');

  expect(result).toEqual({ lines: ['Ship it.', '#push-back '], cursorLine: 1, cursorCol: 11 });
});

it('reuses the space after the cursor', () => {
  const { provider } = suggest(['Ship #pu now'], 0, 8);
  const item = { value: '#push-back', label: 'Push back' };

  const result = provider.applyCompletion(['Ship #pu now'], 0, 8, item, '#pu');

  expect(result).toEqual({ lines: ['Ship #push-back now'], cursorLine: 0, cursorCol: 15 });
});

it.each([
  { case: 'a file mention', line: 'Read @sr' },
  { case: 'a markdown heading', line: '# Heading' },
  { case: 'a token in inline code', line: 'Use `#simp`' },
])('passes $case to the wrapped provider', async ({ line }) => {
  const { wrapped, result } = suggest([line], 0, line.length);

  expect(await result).toEqual({ items: [wrappedItem], prefix: '@sr' });
  expect(wrapped.getSuggestions).toHaveBeenCalledOnce();
});

it.each(['#', 'Read #', 'Read (#'])('shows no list for the bare # in %s', async (line) => {
  const { wrapped, result } = suggest([line], 0, line.length);

  expect(await result).toBeNull();
  expect(wrapped.getSuggestions).not.toHaveBeenCalled();
});

it('shows no list when no snippet matches the query', async () => {
  const { result } = suggest(['#zzzz'], 0, 5);

  expect(await result).toBeNull();
});

it('leaves completions of other suggestions to the wrapped provider', () => {
  const { wrapped, provider } = suggest(['Read @sr'], 0, 8);

  const result = provider.applyCompletion(['Read @sr'], 0, 8, wrappedItem, '@sr');

  expect(result).toEqual({ lines: ['wrapped'], cursorLine: 0, cursorCol: 7 });
  expect(wrapped.applyCompletion).toHaveBeenCalledWith(['Read @sr'], 0, 8, wrappedItem, '@sr');
});
