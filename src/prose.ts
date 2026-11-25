import { Marked } from 'marked';
import type { Token, Tokens } from 'marked';

type ProseRule = 'longSentence' | 'emDash' | 'curlyQuote';

export interface ProseSentence {
  text: string;
  line: number;
  words: number;
}

export interface ProseFinding {
  rule: ProseRule;
  line: number;
  excerpt: string;
}

interface ProseSegment {
  text: string;
  raw: string;
}

interface ProseBlock {
  startLine: number;
  tokens: readonly Token[];
}

interface SentenceSpan {
  text: string;
  start: number;
}

const ruleOrder: readonly ProseRule[] = ['longSentence', 'emDash', 'curlyQuote'];

const curlyQuotes = ['\u2018', '\u2019', '\u201C', '\u201D'];

const emDash = '\u2014';
const longestSentence = 40;
const excerptLength = 100;
const sentenceEnd = /[.!?](?=\s|$)/g;

const lexer = new Marked();

const newlineCount = (text: string): number => text.split('\n').length - 1;

const countWords = (text: string): number => text.split(/\s+/).filter((word) => word !== '').length;

const childTokens = (token: Token): readonly Token[] => {
  const generic: Tokens.Generic = token;

  return generic.tokens ?? [];
};

const isLink = (token: Token): token is Tokens.Link =>
  token.type === 'link' && 'href' in token && typeof token.href === 'string';

const isList = (token: Token): token is Tokens.List =>
  token.type === 'list' && 'items' in token && Array.isArray(token.items);

const isTable = (token: Token): token is Tokens.Table =>
  token.type === 'table' && 'header' in token && Array.isArray(token.header);

const isUrlLink = (token: Tokens.Link): boolean =>
  !token.raw.startsWith('[') || token.text === token.href;

const plainSegment = (token: Token): ProseSegment | undefined => {
  if (token.type === 'codespan') {
    return { text: 'code', raw: token.raw };
  }

  if (token.type === 'image' || token.type === 'html') {
    return { text: '', raw: token.raw };
  }

  if (token.type === 'br' || token.type === 'softbreak') {
    return { text: ' ', raw: token.raw };
  }

  if (token.type === 'text' || token.type === 'escape') {
    const text: unknown = token.text;

    return { text: typeof text === 'string' ? text : '', raw: token.raw };
  }

  return undefined;
};

const segmentsOf = (tokens: readonly Token[]): ProseSegment[] => {
  const segments: ProseSegment[] = [];

  for (const token of tokens) {
    if (isLink(token)) {
      const label = segmentsOf(token.tokens)
        .map((segment) => segment.text)
        .join('');

      const text = isUrlLink(token) ? 'url' : label;

      segments.push({ text, raw: token.raw });

      continue;
    }

    const plain = plainSegment(token);

    if (plain !== undefined) {
      segments.push(plain);

      continue;
    }

    segments.push(...segmentsOf(childTokens(token)));
  }

  return segments;
};

const collectTableBlocks = (table: Tokens.Table, line: number, blocks: ProseBlock[]): void => {
  const rows = [table.header, ...table.rows];

  rows.forEach((row, rowIndex) => {
    const rowLine = rowIndex === 0 ? line : line + rowIndex + 1;

    for (const cell of row) {
      blocks.push({ startLine: rowLine, tokens: cell.tokens });
    }
  });
};

const collectBlocks = (tokens: readonly Token[], startLine: number, blocks: ProseBlock[]): void => {
  let line = startLine;

  for (const token of tokens) {
    if (token.type === 'paragraph' || token.type === 'heading') {
      blocks.push({ startLine: line, tokens: token.tokens ?? [] });
    } else if (token.type === 'text') {
      // A tight list item holds its paragraph as one text token.
      blocks.push({ startLine: line, tokens: token.tokens ?? [token] });
    } else if (isTable(token)) {
      collectTableBlocks(token, line, blocks);
    } else if (isList(token)) {
      collectBlocks(token.items, line, blocks);
    } else if (token.type === 'list_item') {
      collectBlocks(token.tokens ?? [], line, blocks);
    }

    line += newlineCount(token.raw);
  }
};

const lineAt = (segments: readonly ProseSegment[], start: number, blockLine: number): number => {
  let position = 0;
  let line = blockLine;

  for (const segment of segments) {
    const end = position + segment.text.length;

    if (end > start) {
      break;
    }

    line += newlineCount(segment.raw);
    position = end;
  }

  return line;
};

const sentenceSpans = (text: string): SentenceSpan[] => {
  const spans: SentenceSpan[] = [];
  let start = 0;

  for (const match of text.matchAll(sentenceEnd)) {
    const end = match.index + 1;
    const sentence = text.slice(start, end).trim();

    spans.push({ text: sentence, start });
    start = end;
  }

  const last = text.slice(start).trim();

  spans.push({ text: last, start });

  return spans.filter((span) => span.text !== '');
};

const sentencesOfBlock = (block: ProseBlock): ProseSentence[] => {
  const segments = segmentsOf(block.tokens);
  const text = segments.map((segment) => segment.text).join('');
  const spans = sentenceSpans(text);

  return spans.map((span) => ({
    text: span.text,
    line: lineAt(segments, span.start, block.startLine),
    words: countWords(span.text),
  }));
};

export const proseSentences = (markdown: string): ProseSentence[] => {
  const blocks: ProseBlock[] = [];
  const tokens = lexer.lexer(markdown.replaceAll('\r\n', '\n'));

  collectBlocks(tokens, 1, blocks);

  return blocks.flatMap(sentencesOfBlock);
};

const rulesOf = (sentence: ProseSentence): ProseRule[] => {
  const rules: ProseRule[] = [];

  if (sentence.words > longestSentence) {
    rules.push('longSentence');
  }

  if (sentence.text.includes(emDash)) {
    rules.push('emDash');
  }

  if (curlyQuotes.some((quote) => sentence.text.includes(quote))) {
    rules.push('curlyQuote');
  }

  return rules;
};

const excerptOf = (text: string): string =>
  text.length > excerptLength ? `${text.slice(0, excerptLength)}...` : text;

const byLineThenRule = (left: ProseFinding, right: ProseFinding): number =>
  left.line === right.line
    ? ruleOrder.indexOf(left.rule) - ruleOrder.indexOf(right.rule)
    : left.line - right.line;

const findingsOf = (sentence: ProseSentence): ProseFinding[] => {
  const rules = rulesOf(sentence);
  const excerpt = excerptOf(sentence.text);

  return rules.map((rule) => ({ rule, line: sentence.line, excerpt }));
};

export const checkProse = (markdown: string): ProseFinding[] => {
  const findings = proseSentences(markdown).flatMap(findingsOf);

  return findings.toSorted(byLineThenRule);
};
