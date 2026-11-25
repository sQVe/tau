import { Lexer } from 'marked';
import type { Token, Tokens } from 'marked';

import {
  isMarkdownList,
  markdownTokenText,
  walkMarkdownTokens,
} from '../../../../instructions/markdownLinks.js';
import {
  decisionsSectionName,
  handoverSectionNames,
  summaryHasHeading,
} from '../reportSections.js';
import type { PageInventoryElement, PageInventoryPage, PageVerdict } from './pageInventory.js';
import { elementSeparator } from './pageInventory.js';

export type DecisionsSection = { kind: 'nested' } | { kind: 'section'; tokens: readonly Token[] };

type DecisionsStart =
  | { kind: 'heading'; depth: number }
  | { kind: 'paragraph' }
  | { kind: 'list'; itemIndex: number }
  | { kind: 'blockquote'; innerIndex: number; inner: DecisionsStart };

type DecisionsFound =
  | {
      kind: 'heading';
      index: number;
      token: Tokens.Heading;
      start: Extract<DecisionsStart, { kind: 'heading' }>;
    }
  | {
      kind: 'paragraph';
      index: number;
      token: Token;
      start: Extract<DecisionsStart, { kind: 'paragraph' }>;
    }
  | {
      kind: 'list';
      index: number;
      token: Tokens.List;
      start: Extract<DecisionsStart, { kind: 'list' }>;
    }
  | {
      kind: 'blockquote';
      index: number;
      token: Tokens.Blockquote;
      start: Extract<DecisionsStart, { kind: 'blockquote' }>;
    };

const unresolvedVerdicts: ReadonlySet<PageVerdict> = new Set(['contradicts', 'unsure']);

const isHeading = (token: Token): token is Tokens.Heading => token.type === 'heading';

const isBlockquote = (token: Token): token is Tokens.Blockquote =>
  token.type === 'blockquote' && 'tokens' in token && Array.isArray(token.tokens);

export const blockInlineText = (token: Token): string | undefined => {
  if (token.type === 'text') {
    if ('tokens' in token && Array.isArray(token.tokens)) {
      return markdownTokenText(token.tokens);
    }

    const text: unknown = token.text;

    return typeof text === 'string' ? text : '';
  }

  if (token.type !== 'paragraph' && token.type !== 'heading') {
    return undefined;
  }

  return 'tokens' in token && Array.isArray(token.tokens) ? markdownTokenText(token.tokens) : '';
};

const markdownText = (text: string): string => markdownTokenText(Lexer.lexInline(text)).trim();

const sectionName = (text: string): string => {
  const trimmed = text
    .trim()
    .replace(/^\*+|\*+$/gu, '')
    .trim();

  const match = /^([^:(]*)(?:[:(]|$)/u.exec(trimmed);

  return (match?.[1] ?? trimmed).trim();
};

const isDecisionsText = (text: string): boolean => summaryHasHeading(text, decisionsSectionName);

const decisionsStart = (token: Token): DecisionsStart | undefined => {
  const text = blockInlineText(token);

  if (text !== undefined && isDecisionsText(text)) {
    return isHeading(token) ? { kind: 'heading', depth: token.depth } : { kind: 'paragraph' };
  }

  if (isBlockquote(token)) {
    for (const [innerIndex, child] of token.tokens.entries()) {
      const inner = decisionsStart(child);

      if (inner !== undefined) {
        return { kind: 'blockquote', innerIndex, inner };
      }
    }

    return undefined;
  }

  if (isMarkdownList(token)) {
    const itemIndex = token.items.findIndex((item) => {
      const itemText = markdownText(item.text);

      return isDecisionsText(itemText);
    });

    return itemIndex === -1 ? undefined : { kind: 'list', itemIndex };
  }

  return undefined;
};

const endsAtOrAbove = (token: Tokens.Heading, depth: number | undefined): boolean =>
  depth === undefined || token.depth <= depth;

const hasSectionName = (text: string): boolean =>
  handoverSectionNames.some((name) => summaryHasHeading(text, name));

const firstInlineText = (item: Tokens.ListItem): string | undefined => {
  for (const token of item.tokens) {
    const text = blockInlineText(token);

    if (text !== undefined) {
      return text;
    }
  }

  return undefined;
};

const sectionIndex = (text: string): number =>
  handoverSectionNames.findIndex((name) => name.toLowerCase() === sectionName(text).toLowerCase());

const decisionsIndex = handoverSectionNames.indexOf(decisionsSectionName);

export const elementLabels = (pages: readonly PageInventoryPage[]): ReadonlySet<string> => {
  const labels = pages
    .flatMap((page) => page.elements)
    .map((element) => markdownText(element.element).toLowerCase());

  return new Set(labels);
};

const isSectionItem = (item: Tokens.ListItem, knownElements: ReadonlySet<string>): boolean => {
  const text = firstInlineText(item)?.trim() ?? '';
  const index = sectionIndex(text);
  const label = markdownText(text.split(elementSeparator)[0] ?? '').toLowerCase();

  if (index === -1 || knownElements.has(label)) {
    return false;
  }

  return text.endsWith(':') || index > decisionsIndex;
};

const isSectionLabel = (token: Token, knownElements: ReadonlySet<string>): boolean => {
  if (isMarkdownList(token)) {
    const [first] = token.items;

    return first !== undefined && isSectionItem(first, knownElements);
  }

  if (isBlockquote(token)) {
    return token.tokens.some((child) => isSectionLabel(child, knownElements));
  }

  const text = blockInlineText(token);

  return text !== undefined && hasSectionName(text);
};

const endsDecisions = (
  token: Token,
  depth: number | undefined,
  knownElements: ReadonlySet<string>,
): boolean => {
  if (isHeading(token)) {
    return isSectionLabel(token, knownElements) || endsAtOrAbove(token, depth);
  }

  return isSectionLabel(token, knownElements);
};

const cutAtHeading = (
  tokens: readonly Token[],
  depth: number | undefined,
  knownElements: ReadonlySet<string>,
): readonly Token[] => {
  const end = tokens.findIndex((token) => endsDecisions(token, depth, knownElements));

  return end === -1 ? tokens : tokens.slice(0, end);
};

const isLabelToken = (token: Token): boolean => {
  const text = blockInlineText(token);

  return text !== undefined && isDecisionsText(text);
};

const reducedList = (
  list: Tokens.List,
  itemIndex: number,
  knownElements: ReadonlySet<string>,
): Token[] => {
  const item = list.items[itemIndex];
  const rest = list.items.slice(itemIndex + 1);
  const end = rest.findIndex((restItem) => isSectionItem(restItem, knownElements));
  const kept = end === -1 ? rest : rest.slice(0, end);
  const nested = item === undefined ? [] : item.tokens.filter((token) => !isLabelToken(token));
  const siblings = kept.length === 0 ? [] : [{ ...list, items: kept }];

  return [...nested, ...siblings];
};

const reducedInnerList = (
  token: Token | undefined,
  itemIndex: number | undefined,
  knownElements: ReadonlySet<string>,
): Token[] =>
  token !== undefined && itemIndex !== undefined && isMarkdownList(token)
    ? reducedList(token, itemIndex, knownElements)
    : [];

const findDecisionsStart = (tokens: readonly Token[]): DecisionsFound | undefined => {
  for (const [index, token] of tokens.entries()) {
    const start = decisionsStart(token);

    if (start === undefined) {
      continue;
    }

    if (start.kind === 'heading' && isHeading(token)) {
      return { kind: 'heading', index, token, start };
    }

    if (start.kind === 'paragraph') {
      return { kind: 'paragraph', index, token, start };
    }

    if (start.kind === 'list' && isMarkdownList(token)) {
      return { kind: 'list', index, token, start };
    }

    if (start.kind === 'blockquote' && isBlockquote(token)) {
      return { kind: 'blockquote', index, token, start };
    }
  }

  return undefined;
};

const startDepth = (start: DecisionsStart): number | undefined => {
  if (start.kind === 'heading') {
    return start.depth;
  }

  if (start.kind === 'blockquote') {
    return startDepth(start.inner);
  }

  return undefined;
};

export const readDecisionsSection = (
  tokens: readonly Token[],
  knownElements: ReadonlySet<string>,
): DecisionsSection => {
  const found = findDecisionsStart(tokens);

  if (found === undefined) {
    return { kind: 'section', tokens: [] };
  }

  if (found.kind === 'blockquote' && found.start.inner.kind === 'blockquote') {
    return { kind: 'nested' };
  }

  const depth = startDepth(found.start);
  const after = tokens.slice(found.index + 1);
  const tail = cutAtHeading(after, depth, knownElements);

  if (found.kind === 'list') {
    return {
      kind: 'section',
      tokens: [...reducedList(found.token, found.start.itemIndex, knownElements), ...tail],
    };
  }

  if (found.kind !== 'blockquote') {
    return { kind: 'section', tokens: tail };
  }

  const innerToken = found.token.tokens[found.start.innerIndex];
  const innerDepth = startDepth(found.start.inner);

  const innerItemIndex =
    found.start.inner.kind === 'list' ? found.start.inner.itemIndex : undefined;

  const innerTail = cutAtHeading(
    found.token.tokens.slice(found.start.innerIndex + 1),
    innerDepth,
    knownElements,
  );

  return {
    kind: 'section',
    tokens: [...reducedInnerList(innerToken, innerItemIndex, knownElements), ...innerTail, ...tail],
  };
};

const itemText = (item: Tokens.ListItem): string => item.text.trim();

const collectFindingsInto = (
  tokens: readonly Token[],
  findings: string[],
  knownElements: ReadonlySet<string>,
): boolean => {
  let stopped = false;

  walkMarkdownTokens(tokens, (token) => {
    if (stopped) {
      return false;
    }

    if (!isMarkdownList(token)) {
      return undefined;
    }

    for (const item of token.items) {
      if (isSectionItem(item, knownElements)) {
        stopped = true;

        return false;
      }

      findings.push(itemText(item));

      if (collectFindingsInto(item.tokens, findings, knownElements)) {
        stopped = true;

        return false;
      }
    }

    return false;
  });

  return stopped;
};

export const collectFindings = (
  tokens: readonly Token[],
  knownElements: ReadonlySet<string>,
): string[] => {
  const findings: string[] = [];

  collectFindingsInto(tokens, findings, knownElements);

  return findings;
};

const findingLabel = (line: string): string | undefined => {
  const content = /^[ \t]*([^\n]*)/u.exec(line)?.[1] ?? '';
  const at = content.indexOf(elementSeparator);

  if (at <= 0) {
    return undefined;
  }

  const label = markdownText(content.slice(0, at));
  const text = content.slice(at + elementSeparator.length).trim();

  return label !== '' && text !== '' ? label : undefined;
};

const namesElement = (element: string, findings: readonly string[]): boolean => {
  const label = markdownText(element).toLowerCase();

  return findings.some((finding) => findingLabel(finding)?.toLowerCase() === label);
};

export const isUnresolved = (element: PageInventoryElement, findings: readonly string[]): boolean =>
  unresolvedVerdicts.has(element.verdict) && !namesElement(element.element, findings);

export const needsFinding = (pages: readonly PageInventoryPage[]): boolean =>
  pages.flatMap((page) => page.elements).some((element) => unresolvedVerdicts.has(element.verdict));
