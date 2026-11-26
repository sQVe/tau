import { isHttpUrl } from '../../launchEnvironment.js';

export interface PageInventoryElement {
  element: string;
  expectedState: string;
  verdict: PageVerdict;
}

export interface PageInventoryPage {
  url: string;
  elements: PageInventoryElement[];
}

export type PageInventoryProblem =
  | { kind: 'element' }
  | { kind: 'verdict'; verdict: string }
  | { kind: 'placement' }
  | { kind: 'page' };

export type ParsedPageInventory =
  | { status: 'malformed'; line: number; problem: PageInventoryProblem }
  | { status: 'valid'; pages: PageInventoryPage[] };

type ElementParse =
  | { status: 'parsed'; element: PageInventoryElement }
  | { status: 'malformed'; line: number; problem: PageInventoryProblem };

type InventoryLine =
  | { kind: 'skip' }
  | { kind: 'page'; url: string }
  | { kind: 'element'; content: string }
  | { kind: 'malformed'; problem: PageInventoryProblem };

export const verdictNames = ['matches', 'contradicts', 'unsure'] as const;

export type PageVerdict = (typeof verdictNames)[number];

const verdicts: ReadonlySet<string> = new Set(verdictNames);

export const elementSeparator = ': ';

const isVerdict = (value: string): value is PageVerdict => verdicts.has(value);

export const normalizeNewlines = (text: string): string =>
  text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

// The element is the text before the first separator, so the expected state may contain ": ".
const parseElement = (content: string, line: number): ElementParse => {
  const elementAt = content.indexOf(elementSeparator);
  const verdictAt = content.lastIndexOf(elementSeparator);

  if (elementAt <= 0) {
    return { status: 'malformed', line, problem: { kind: 'element' } };
  }

  const element = content.slice(0, elementAt).trim();
  const expectedState = content.slice(elementAt + elementSeparator.length, verdictAt).trim();
  const verdict = content.slice(verdictAt + elementSeparator.length).trim();

  if (expectedState === '') {
    return { status: 'malformed', line, problem: { kind: 'element' } };
  }

  if (!isVerdict(verdict)) {
    return { status: 'malformed', line, problem: { kind: 'verdict', verdict } };
  }

  return { status: 'parsed', element: { element, expectedState, verdict } };
};

const nonDashBulletPattern = /^[*+]/u;

const readLine = (trimmed: string): InventoryLine => {
  if (trimmed === '' || trimmed.startsWith('#')) {
    return { kind: 'skip' };
  }

  if (trimmed.startsWith('-') || nonDashBulletPattern.test(trimmed)) {
    const item = /^-\s+(.*)$/u.exec(trimmed);

    return item === null
      ? { kind: 'malformed', problem: { kind: 'element' } }
      : { kind: 'element', content: item[1] ?? '' };
  }

  const isPage = isHttpUrl(trimmed) && !/\s/u.test(trimmed);

  return isPage ? { kind: 'page', url: trimmed } : { kind: 'malformed', problem: { kind: 'page' } };
};

export const parsePageInventory = (text: string): ParsedPageInventory => {
  const pages: PageInventoryPage[] = [];
  let current: PageInventoryPage | undefined;

  for (const [index, raw] of normalizeNewlines(text).split('\n').entries()) {
    const line = index + 1;
    const read = readLine(raw.trim());

    if (read.kind === 'skip') {
      continue;
    }

    if (read.kind === 'malformed') {
      return { status: 'malformed', line, problem: read.problem };
    }

    if (read.kind === 'page') {
      current = { url: read.url, elements: [] };
      pages.push(current);

      continue;
    }

    if (current === undefined) {
      return { status: 'malformed', line, problem: { kind: 'placement' } };
    }

    const parsed = parseElement(read.content, line);

    if (parsed.status === 'malformed') {
      return parsed;
    }

    current.elements.push(parsed.element);
  }

  return { status: 'valid', pages };
};
