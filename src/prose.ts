import { Marked } from 'marked';
import type { MarkedToken, Token, Tokens } from 'marked';

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
  line: number;
}

interface ProseBlock {
  startLine: number;
  tokens: readonly MarkedToken[];
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
const maxQuoteDepth = 8;
const sentenceEnd = /[.!?](?=\s|$)/g;
const quoteMarkers = /^(?:[ \t]*>)+/;
const longQuoteRun = />{9,}/g;
const entityReference = /&#?[\da-z]+;/gi;
const decimalRadix = 10;
const hexadecimalRadix = 16;
const decimalPrefixLength = 2;
const hexadecimalPrefixLength = 3;
const lastCodePoint = 0x10ffff;

const lexer = new Marked();

const entities = new Map<string, string>([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['hellip', '\u2026'],
  ['ldquo', '\u201C'],
  ['lsquo', '\u2018'],
  ['lt', '<'],
  ['mdash', '\u2014'],
  ['nbsp', '\u00A0'],
  ['ndash', '\u2013'],
  ['quot', '"'],
  ['rdquo', '\u201D'],
  ['rsquo', '\u2019'],
]);

const newlineCount = (text: string): number => text.split('\n').length - 1;
const countWords = (text: string): number => text.match(/\S+/g)?.length ?? 0;

const decodedEntity = (reference: string): string => {
  if (!reference.startsWith('&#')) {
    const name = reference.slice(1, -1).toLowerCase();

    return entities.get(name) ?? reference;
  }

  const hexadecimal = reference.slice(0, hexadecimalPrefixLength).toLowerCase() === '&#x';
  const prefixLength = hexadecimal ? hexadecimalPrefixLength : decimalPrefixLength;
  const radix = hexadecimal ? hexadecimalRadix : decimalRadix;
  const code = Number.parseInt(reference.slice(prefixLength, -1), radix);

  return code <= lastCodePoint ? String.fromCodePoint(code) : reference;
};

const decodedText = (text: string): string => text.replaceAll(entityReference, decodedEntity);

const boundLineQuotes = (line: string): string => {
  const markers = quoteMarkers.exec(line)?.[0];

  if (markers === undefined) {
    return line;
  }

  const depth = markers.split('>').length - 1;

  if (depth <= maxQuoteDepth) {
    return line;
  }

  return `${'> '.repeat(maxQuoteDepth)}${line.slice(markers.length)}`;
};

const boundedQuotes = (markdown: string): string => {
  const bounded = markdown.replaceAll(longQuoteRun, '>'.repeat(maxQuoteDepth));

  return bounded.split('\n').map(boundLineQuotes).join('\n');
};

const childTokens = (token: Token | Tokens.TableCell): readonly MarkedToken[] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Nested tokens come from the same marked lexer.
  ('tokens' in token ? token.tokens : []) as readonly MarkedToken[];

const isUrlLink = (token: Tokens.Link): boolean =>
  !token.raw.startsWith('[') || token.text === token.href;

const textSegments = (text: string, line: number): ProseSegment[] => {
  const segments: ProseSegment[] = [];

  for (const [index, piece] of text.split('\n').entries()) {
    const prefix = index === 0 ? '' : ' ';

    segments.push({ text: `${prefix}${decodedText(piece)}`, line: line + index });
  }

  return segments;
};

const segmentsOf = (tokens: readonly MarkedToken[], startLine: number): ProseSegment[] => {
  const segments: ProseSegment[] = [];
  let line = startLine;

  for (const token of tokens) {
    if (token.type === 'link') {
      if (isUrlLink(token)) {
        segments.push({ text: 'url', line });
      } else {
        segments.push(...segmentsOf(childTokens(token), line));
      }
    } else if (token.type === 'codespan') {
      segments.push({ text: 'code', line });
    } else if (token.type === 'br') {
      segments.push({ text: ' ', line });
    } else if (token.type === 'text' || token.type === 'escape') {
      segments.push(...textSegments(token.text, line));
    } else if (token.type !== 'image' && token.type !== 'html') {
      segments.push(...segmentsOf(childTokens(token), line));
    }

    line += newlineCount(token.raw);
  }

  return segments;
};

const tableCells = (
  table: Tokens.Table,
  line: number,
): { rowLine: number; cell: Tokens.TableCell }[] =>
  [table.header, ...table.rows].flatMap((row, rowIndex) => {
    const rowLine = rowIndex === 0 ? line : line + rowIndex + 1;

    return row.map((cell) => ({ rowLine, cell }));
  });

const collectBlocks = (
  tokens: readonly MarkedToken[],
  startLine: number,
  blocks: ProseBlock[],
): void => {
  let line = startLine;

  for (const token of tokens) {
    if (token.type === 'paragraph' || token.type === 'heading' || token.type === 'text') {
      blocks.push({ startLine: line, tokens: childTokens(token) });
    } else if (token.type === 'table') {
      for (const { rowLine, cell } of tableCells(token, line)) {
        blocks.push({ startLine: rowLine, tokens: childTokens(cell) });
      }
    } else if (token.type === 'list') {
      collectBlocks(token.items, line, blocks);
    } else if (token.type === 'list_item') {
      collectBlocks(childTokens(token), line, blocks);
    }

    line += newlineCount(token.raw);
  }
};

const lineAt = (segments: readonly ProseSegment[], start: number, blockLine: number): number => {
  let position = 0;

  for (const segment of segments) {
    if (start < position + segment.text.length) {
      return segment.line;
    }

    position += segment.text.length;
  }

  return blockLine;
};

const firstNonWhitespace = (text: string, from: number, end: number): number => {
  const offset = text.slice(from, end).search(/\S/);

  return offset === -1 ? end : from + offset;
};

const pushSpan = (spans: SentenceSpan[], text: string, start: number, end: number): void => {
  const sentence = text.slice(start, end).trim();

  if (sentence !== '') {
    spans.push({ text: sentence, start });
  }
};

const sentenceSpans = (text: string): SentenceSpan[] => {
  const spans: SentenceSpan[] = [];
  let from = 0;

  for (const match of text.matchAll(sentenceEnd)) {
    const end = match.index + 1;

    pushSpan(spans, text, firstNonWhitespace(text, from, end), end);
    from = end;
  }

  pushSpan(spans, text, firstNonWhitespace(text, from, text.length), text.length);

  return spans;
};

const sentencesOfBlock = (block: ProseBlock): ProseSentence[] => {
  const segments = segmentsOf(block.tokens, block.startLine);
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
  const normalized = markdown.replaceAll('\r\n', '\n');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The default marked lexer emits marked token shapes.
  const tokens = lexer.lexer(boundedQuotes(normalized)) as readonly MarkedToken[];

  collectBlocks(tokens, 1, blocks);

  return blocks.flatMap(sentencesOfBlock);
};

const findingsOf = (sentence: ProseSentence): ProseFinding[] => {
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

  const excerpt =
    sentence.text.length > excerptLength
      ? `${sentence.text.slice(0, excerptLength)}...`
      : sentence.text;

  return rules.map((rule) => ({ rule, line: sentence.line, excerpt }));
};

const byLineThenRule = (left: ProseFinding, right: ProseFinding): number =>
  left.line - right.line || ruleOrder.indexOf(left.rule) - ruleOrder.indexOf(right.rule);

export const checkProse = (markdown: string): ProseFinding[] =>
  proseSentences(markdown).flatMap(findingsOf).toSorted(byLineThenRule);
