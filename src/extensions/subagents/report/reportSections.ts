import { Marked } from 'marked';
import type { Token, Tokens } from 'marked';

import { markdownTokenText, walkMarkdownTokens } from '../../../instructions/markdownLinks.js';

export const decisionsSectionName = 'Decisions';

export const handoverSectionNames = [
  'Changes',
  'Evidence',
  decisionsSectionName,
  'Concerns',
] as const;

const markdown = new Marked();

// Matches one block of inline text, such as a paragraph or a list item's text, not a document.
export const fragmentHasHeading = (text: string, name: string): boolean =>
  new RegExp(`^[\\s#*>-]*${name}\\**\\s*(?::|\\(|$)`, 'im').test(text);

// Only a heading, paragraph, or block text token is tested, and its inline children are skipped, so
// a link label or a table cell cannot count as a heading. A blockquote and a list hold blocks, so
// the walk continues into them.
const blockTextTypes: ReadonlySet<string> = new Set(['heading', 'paragraph', 'text']);

const isBlockText = (token: Token): boolean => blockTextTypes.has(token.type);

const isTable = (token: Token): boolean => token.type === 'table';

const isHeading = (token: Token): token is Tokens.Heading => token.type === 'heading';

// A heading's raw text keeps its closing hashes and link syntax, so its parsed label is tested.
const headingLabel = (token: Tokens.Heading): string => markdownTokenText(token.tokens);

const blockTextOf = (token: Token): string => (isHeading(token) ? headingLabel(token) : token.raw);

export const summaryHasHeading = (summary: string, name: string): boolean => {
  let found = false;

  walkMarkdownTokens(markdown.lexer(summary), (token) => {
    if (isBlockText(token)) {
      found ||= fragmentHasHeading(blockTextOf(token), name);

      return false;
    }

    if (isTable(token)) {
      return false;
    }

    return undefined;
  });

  return found;
};
