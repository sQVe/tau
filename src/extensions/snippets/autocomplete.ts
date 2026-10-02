import { fuzzyFilter } from '@earendil-works/pi-tui';
import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';

import { insertSnippetBody } from './insertion.js';
import { snippetQueryAt } from './query.js';
import type { Snippet } from './types.js';

type EditorPosition = [lines: string[], cursorLine: number, cursorCol: number];

const queryAt = (...[lines, cursorLine, cursorCol]: EditorPosition) => {
  const before = lines.slice(0, cursorLine).join('\n');
  const offset = (cursorLine === 0 ? 0 : before.length + 1) + cursorCol;

  return snippetQueryAt(lines.join('\n'), offset);
};

const endsQuery = (lines: string[], cursorLine: number, cursorCol: number) => {
  const line = lines[cursorLine] ?? '';
  const afterWhitespace = /\s$/.test(line.slice(0, cursorCol));

  return afterWhitespace && queryAt(lines, cursorLine, cursorCol - 1) !== undefined;
};

const itemValue = (snippet: Snippet) => `#${snippet.id}`;

/** The snippet that a snippet list item inserts, or `undefined` for other items. */
export const snippetForItem = (snippets: Snippet[], item: AutocompleteItem) =>
  snippets.find((candidate) => itemValue(candidate) === item.value);

const suggestionFor = (snippet: Snippet): AutocompleteItem => ({
  value: itemValue(snippet),
  label: itemValue(snippet),
  description:
    snippet.description === '' ? snippet.name : `${snippet.name} - ${snippet.description}`,
});

/**
 * Suggests snippets for a `#` query, matched by id, name, and description, and
 * replaces the query with the body of the picked snippet. Everything else goes
 * to the wrapped provider.
 */
export const snippetAutocomplete =
  (readSnippets: () => Snippet[]) =>
  (wrapped: AutocompleteProvider): AutocompleteProvider => ({
    triggerCharacters: ['#'],
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
      const query = queryAt(lines, cursorLine, cursorCol);

      // pi-tui refreshes an open list on each key. After a space ends a `#` query, the wrapped
      // provider would replace the snippet list with every file in the directory.
      if (
        query === undefined &&
        options.force !== true &&
        endsQuery(lines, cursorLine, cursorCol)
      ) {
        return null;
      }

      if (query === undefined) {
        return wrapped.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const matches = fuzzyFilter(
        readSnippets(),
        query,
        (snippet) => `${snippet.id} ${snippet.name} ${snippet.description}`,
      );

      return matches.length === 0
        ? null
        : { items: matches.map(suggestionFor), prefix: `#${query}` };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      const query = queryAt(lines, cursorLine, cursorCol);
      const isQuery = query !== undefined && prefix === `#${query}`;
      const snippet = snippetForItem(readSnippets(), item);

      if (!isQuery || snippet === undefined) {
        return wrapped.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }

      const range = { line: cursorLine, start: cursorCol - prefix.length, end: cursorCol };

      return insertSnippetBody(lines, range, snippet.body);
    },
    ...(wrapped.shouldTriggerFileCompletion === undefined
      ? {}
      : { shouldTriggerFileCompletion: wrapped.shouldTriggerFileCompletion.bind(wrapped) }),
  });
