import { Marked } from 'marked';
import type { Token, Tokens } from 'marked';

import {
  isMarkdownList,
  isMarkdownTable,
  markdownTokenText,
  readDestination,
  walkMarkdownTokens,
} from '../../../../instructions/markdownLinks.js';
import type {
  PageInventoryPage,
  PageInventoryProblem,
  ParsedPageInventory,
} from './pageInventory.js';
import { normalizeNewlines } from './pageInventory.js';
import {
  blockInlineText,
  collectFindings,
  elementLabels,
  isUnresolved,
  needsFinding,
  readDecisionsSection,
} from './pageInventoryDecisions.js';
import {
  elementBeforePageMessage,
  inventoryEmptyMessage,
  inventoryMissingMessage,
  inventoryNotRegularMessage,
  inventoryTooLargeMessage,
  inventoryUncitedMessage,
  inventoryUnreadableMessage,
  malformedElementMessage,
  nestedDecisionsMessage,
  notPageUrlMessage,
  pageWithoutElementMessage,
  unknownVerdictMessage,
  unresolvedElementMessage,
} from './pageInventoryRefusal.js';

export type PageInventoryRead =
  | ParsedPageInventory
  | { status: 'missing' }
  | { status: 'notRegular' }
  | { status: 'tooLarge' }
  | { status: 'unreadable' };

export interface PageInventoryGateFacts {
  profile: string;
  appUrl: boolean;
  inventoryPath: string;
  read: PageInventoryRead;
  summary: string;
  evidence: readonly string[];
}

export type PageInventoryGateDecision =
  | { status: 'accept' }
  | { status: 'refuse'; message: string };

const markdown = new Marked();

export const appliesPageInventoryGate = (profile: string, appUrl: boolean): boolean =>
  profile === 'qa' && appUrl;

const linkDestinations = (tokens: readonly Token[]): string[] => {
  const destinations: string[] = [];

  walkMarkdownTokens(tokens, (child) => {
    if (child.type === 'link') {
      const href = String(child.href);
      const destination = readDestination(href);

      const destinationPath = destination.kind === 'local' ? destination.path : href;

      destinations.push(destinationPath);
    }
  });

  return destinations;
};

const cellText = (tokens: readonly Token[]): string => {
  const parts = [markdownTokenText(tokens), ...linkDestinations(tokens)].filter(
    (part) => part !== '',
  );

  return `${parts.join(' ')}\n`;
};

const tableCells = (token: Tokens.Table): string[] => {
  const cells = [...token.header, ...token.rows.flat()];

  return cells.map((cell) => cellText(cell.tokens));
};

const summaryText = (tokens: readonly Token[]): string => {
  const parts: string[] = [];

  walkMarkdownTokens(tokens, (token) => {
    if (token.type === 'space' || token.type === 'hr') {
      parts.push('\n');

      return false;
    }

    if (isMarkdownList(token)) {
      for (const item of token.items) {
        parts.push(summaryText(item.tokens));
      }

      return false;
    }

    if (isMarkdownTable(token)) {
      parts.push(...tableCells(token));

      return false;
    }

    if (token.type === 'blockquote') {
      parts.push(summaryText(token.tokens ?? []));

      return false;
    }

    const inline = blockInlineText(token);

    const lineParts = [inline, ...linkDestinations([token])].filter(
      (part): part is string => part !== undefined && part !== '',
    );

    parts.push(`${lineParts.join(' ')}\n`);

    return false;
  });

  return parts.join('');
};

const refusal = (message: string): PageInventoryGateDecision => ({ status: 'refuse', message });

const malformedRefusal = (
  line: number,
  problem: PageInventoryProblem,
): PageInventoryGateDecision => {
  if (problem.kind === 'element') {
    return refusal(malformedElementMessage(line));
  }

  if (problem.kind === 'verdict') {
    return refusal(unknownVerdictMessage(line, problem.verdict));
  }

  return problem.kind === 'page'
    ? refusal(notPageUrlMessage(line))
    : refusal(elementBeforePageMessage(line));
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// A path is cited at the start or after a character that cannot continue a path.
const citationStart = '(^|[^\\w./~-])';
// A citation ends at whitespace or text end, after a sentence period, or before closing punctuation.
const citationEnd = `(?=$|\\s|\\.(?=\\s|$|["')\\]])|["')\\]])`;

const summaryCitation = (summary: string, path: string): boolean =>
  new RegExp(`${citationStart}${escapeRegExp(path)}${citationEnd}`, 'mu').test(summary);

const citesInventory = (
  tokens: readonly Token[],
  evidence: readonly string[],
  path: string,
): boolean => {
  const prose = summaryText(tokens);

  return summaryCitation(prose, path) || evidence.some((item) => item.trim() === path);
};

const decideInventory = (
  pages: readonly PageInventoryPage[],
  tokens: readonly Token[],
): PageInventoryGateDecision => {
  if (pages.length === 0) {
    return refusal(inventoryEmptyMessage);
  }

  const emptyPage = pages.find((page) => page.elements.length === 0);

  if (emptyPage !== undefined) {
    return refusal(pageWithoutElementMessage(emptyPage.url));
  }

  const knownElements = elementLabels(pages);
  const section = readDecisionsSection(tokens, knownElements);
  const needsElementFinding = needsFinding(pages);

  if (section.kind === 'nested') {
    return needsElementFinding ? refusal(nestedDecisionsMessage) : { status: 'accept' };
  }

  const findings = collectFindings(section.tokens, knownElements);

  const unresolved = pages
    .flatMap((page) => page.elements)
    .find((element) => isUnresolved(element, findings));

  return unresolved === undefined
    ? { status: 'accept' }
    : refusal(unresolvedElementMessage(unresolved));
};

export const decidePageInventoryGate = (
  facts: PageInventoryGateFacts,
): PageInventoryGateDecision => {
  if (!appliesPageInventoryGate(facts.profile, facts.appUrl)) {
    return { status: 'accept' };
  }

  if (facts.read.status === 'missing') {
    return refusal(inventoryMissingMessage);
  }

  if (facts.read.status === 'unreadable') {
    return refusal(inventoryUnreadableMessage(facts.inventoryPath));
  }

  if (facts.read.status === 'notRegular') {
    return refusal(inventoryNotRegularMessage(facts.inventoryPath));
  }

  if (facts.read.status === 'tooLarge') {
    return refusal(inventoryTooLargeMessage(facts.inventoryPath));
  }

  const summary = normalizeNewlines(facts.summary);
  const tokens = markdown.lexer(summary);

  if (!citesInventory(tokens, facts.evidence, facts.inventoryPath)) {
    return refusal(inventoryUncitedMessage);
  }

  if (facts.read.status === 'malformed') {
    return malformedRefusal(facts.read.line, facts.read.problem);
  }

  return decideInventory(facts.read.pages, tokens);
};
