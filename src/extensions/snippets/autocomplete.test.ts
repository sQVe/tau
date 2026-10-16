import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { snippetAutocomplete } from './autocomplete.js';
import type { Snippet } from './snippet.js';

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

it('finds a query on a line that has lines after it', async () => {
  const { result } = suggest(['First line.', '#simp', 'Last line.'], 1, 5);

  expect((await result)?.items.map((item) => item.value)).toEqual(['#simplify']);
});

it.each([
  { case: 'punctuation ends the query', lines: ['Review #si. '], col: 11 },
  { case: 'the line has no query', lines: ['Read @sr '], col: 9 },
])('passes to the wrapped provider when $case before a space', async ({ lines, col }) => {
  const { wrapped, result } = suggest(lines, 0, col);

  expect(await result).toEqual({ items: [wrappedItem], prefix: '@sr' });
  expect(wrapped.getSuggestions).toHaveBeenCalledOnce();
});

it('passes the file completion trigger of the wrapped provider through', () => {
  const shouldTriggerFileCompletion = vi.fn<() => boolean>(() => true);
  const wrapped = { ...createWrapped(), shouldTriggerFileCompletion };
  const provider = snippetAutocomplete(() => snippets)(wrapped);

  const triggers = provider.shouldTriggerFileCompletion?.(['@'], 0, 1);

  expect(triggers).toBe(true);
  expect(shouldTriggerFileCompletion).toHaveBeenCalledWith(['@'], 0, 1);
});

it('has no file completion trigger when the wrapped provider has none', () => {
  const provider = snippetAutocomplete(() => snippets)(createWrapped());

  expect(provider.shouldTriggerFileCompletion).toBeUndefined();
});

describe('completing a snippet item that does not belong to the query', () => {
  const simplifyItem: AutocompleteItem = { value: '#simplify', label: '#simplify' };

  it.each([
    { case: 'the prefix no longer matches the query', lines: ['#sim'], prefix: '#si' },
    { case: 'the cursor is not in a query', lines: ['hello'], prefix: '#sim' },
    {
      case: 'the cursor is not in a query and the prefix is the word undefined',
      lines: ['hello'],
      prefix: '#undefined',
    },
    {
      case: 'the snippet is gone',
      lines: ['#sim'],
      prefix: '#sim',
      item: { value: '#gone', label: '#gone' },
    },
  ])('passes to the wrapped provider when $case', ({ lines, prefix, item }) => {
    const { wrapped, provider } = suggest(lines, 0, lines[0]?.length ?? 0);
    const column = lines[0]?.length ?? 0;

    const result = provider.applyCompletion(lines, 0, column, item ?? simplifyItem, prefix);

    expect(result).toEqual({ lines: ['wrapped'], cursorLine: 0, cursorCol: 7 });
    expect(wrapped.applyCompletion).toHaveBeenCalledOnce();
  });
});
