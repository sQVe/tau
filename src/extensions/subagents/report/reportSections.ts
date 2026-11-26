import { Marked } from 'marked';
import type { Token, Tokens } from 'marked';

import {
  isMarkdownHeading,
  isMarkdownTable,
  markdownTokenText,
  walkMarkdownTokens,
} from '../../../instructions/markdownLinks.js';

export const decisionsSectionName = 'Decisions';

export const handoverSectionNames = [
  'Changes',
  'Evidence',
  decisionsSectionName,
  'Concerns',
] as const;

export type HandoverSectionName = (typeof handoverSectionNames)[number];

const markdown = new Marked();

// Matches one block of inline text, such as a paragraph or a list item's text, not a document.
export const fragmentHasHeading = (text: string, name: HandoverSectionName): boolean =>
  new RegExp(`^[\\s#*>-]*${name}\\**\\s*(?::|\\(|$)`, 'im').test(text);

// Only a heading, paragraph, or block text token is tested, and its inline children are skipped, so
// a link label or a table cell cannot count as a heading. A blockquote and a list hold blocks, so
// the walk continues into them.
const blockTextTypes: ReadonlySet<string> = new Set(['heading', 'paragraph', 'text']);

const isBlockText = (token: Token): boolean => blockTextTypes.has(token.type);

const headingLabel = (token: Tokens.Heading): string => markdownTokenText(token.tokens);

const blockTextOf = (token: Token): string =>
  isMarkdownHeading(token) ? headingLabel(token) : token.raw;

export const summaryHasHeading = (summary: string, name: HandoverSectionName): boolean => {
  let found = false;

  walkMarkdownTokens(markdown.lexer(summary), (token) => {
    if (isBlockText(token)) {
      found ||= fragmentHasHeading(blockTextOf(token), name);

      return false;
    }

    if (isMarkdownTable(token)) {
      return false;
    }

    return undefined;
  });

  return found;
};
