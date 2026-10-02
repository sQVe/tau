import { fuzzyFilter } from '@earendil-works/pi-tui';
import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';

import { isTokenId, snippetQueryAt } from './tokens.js';
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

const suggestionFor = (snippet: Snippet): AutocompleteItem => ({
  value: `#${snippet.id}`,
  label: `#${snippet.id}`,
  description:
    snippet.description === '' ? snippet.name : `${snippet.name} - ${snippet.description}`,
});

const insertToken = (lines: string[], cursorLine: number, cursorCol: number, token: string) => {
  const line = lines[cursorLine] ?? '';
  const query = queryAt(lines, cursorLine, cursorCol) ?? '';
  const before = line.slice(0, cursorCol - query.length - 1);
  const after = line.slice(cursorCol);
  const space = /^\s/.test(after) ? '' : ' ';
  const updated = [...lines];

  updated[cursorLine] = `${before}${token}${space}${after}`;

  return { lines: updated, cursorLine, cursorCol: before.length + token.length + space.length };
};

/**
 * Suggests snippet tokens for a `#` query, matched by name and description.
 * Everything else goes to the wrapped provider.
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

      const candidates = readSnippets().filter((snippet) => isTokenId(snippet.id));

      const matches = fuzzyFilter(
        candidates,
        query,
        (snippet) => `${snippet.id} ${snippet.name} ${snippet.description}`,
      );

      return matches.length === 0
        ? null
        : { items: matches.map(suggestionFor), prefix: `#${query}` };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      const query = queryAt(lines, cursorLine, cursorCol);
      const isSnippet = query !== undefined && prefix === `#${query}`;

      return isSnippet
        ? insertToken(lines, cursorLine, cursorCol, item.value)
        : wrapped.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    ...(wrapped.shouldTriggerFileCompletion === undefined
      ? {}
      : { shouldTriggerFileCompletion: wrapped.shouldTriggerFileCompletion.bind(wrapped) }),
  });
