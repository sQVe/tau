import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';

import { snippetAutocomplete } from './autocomplete.js';
import type { Snippet } from './types.js';

const createSnippet = (id: string, name: string, description: string): Snippet => ({
  id,
  name,
  description,
  body: `${name}.`,
});

const snippets = [
  createSnippet('push-back', 'Push back', 'Challenge the plan'),
  createSnippet('verify', "Verify, don't assume", 'Check facts first'),
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
    items: [expect.objectContaining({ value: '#verify' })],
    prefix: '#fact',
  });
});

it('finds a query on a later line', async () => {
  const { result } = suggest(['First line.', '#simp'], 1, 5);

  expect((await result)?.items.map((item) => item.value)).toEqual(['#simplify']);
});

const pick = async (lines: string[], cursorLine: number, cursorCol: number) => {
  const { provider, result } = suggest(lines, cursorLine, cursorCol);
  const suggestions = await result;
  const item = suggestions?.items[0];

  if (suggestions === null || item === undefined) {
    throw new Error('No snippet was suggested.');
  }

  return provider.applyCompletion(lines, cursorLine, cursorCol, item, suggestions.prefix);
};

it('inserts the snippet body in place of the query', async () => {
  const result = await pick(['Ship it.', '#push'], 1, 5);

  expect(result).toEqual({ lines: ['Ship it.', 'Push back.'], cursorLine: 1, cursorCol: 10 });
});

it('moves the text around the query apart from the body', async () => {
  const result = await pick(['Ship #push now'], 0, 10);

  expect(result).toEqual({
    lines: ['Ship', '', 'Push back.', '', 'now'],
    cursorLine: 2,
    cursorCol: 10,
  });
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

it.each(['#', 'Read #', 'Read (#'])('lists every snippet for the bare # in %s', async (line) => {
  const { wrapped, result } = suggest([line], 0, line.length);

  const suggestions = await result;
  const values = suggestions?.items.map((item) => item.value);

  expect(values).toEqual(snippets.map((snippet) => `#${snippet.id}`));
  expect(suggestions?.prefix).toBe('#');
  expect(wrapped.getSuggestions).not.toHaveBeenCalled();
});

it('inserts the body of a snippet picked after a bare #', async () => {
  const result = await pick(['Read #'], 0, 6);

  expect(result).toEqual({ lines: ['Read', '', 'Push back.'], cursorLine: 2, cursorCol: 10 });
});

it('closes the list when a space follows a bare #, as in a heading', async () => {
  const { wrapped, result } = suggest(['# '], 0, 2);

  expect(await result).toBeNull();
  expect(wrapped.getSuggestions).not.toHaveBeenCalled();
});

it('closes the list when a space ends the query instead of listing files', async () => {
  const { wrapped, result } = suggest(['Review #simp '], 0, 13);

  expect(await result).toBeNull();
  expect(wrapped.getSuggestions).not.toHaveBeenCalled();
});

it('passes Tab after a finished query to the wrapped provider', async () => {
  const wrapped = createWrapped();
  const provider = snippetAutocomplete(() => snippets)(wrapped);

  const result = await provider.getSuggestions(['Review #simp '], 0, 13, {
    ...options,
    force: true,
  });

  expect(result).toEqual({ items: [wrappedItem], prefix: '@sr' });
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
