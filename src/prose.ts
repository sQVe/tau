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
  raw: string;
}

interface ProseBlock {
  startLine: number;
  tokens: readonly MarkedToken[];
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

const childTokens = (token: Token | Tokens.TableCell): readonly MarkedToken[] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Nested tokens come from the same marked lexer.
  ('tokens' in token ? token.tokens : []) as readonly MarkedToken[];

const isUrlLink = (token: Tokens.Link): boolean =>
  !token.raw.startsWith('[') || token.text === token.href;

const segmentsOf = (tokens: readonly MarkedToken[]): ProseSegment[] => {
  const segments: ProseSegment[] = [];

  for (const token of tokens) {
    if (token.type === 'link') {
      const label = segmentsOf(childTokens(token))
        .map((segment) => segment.text)
        .join('');

      const text = isUrlLink(token) ? 'url' : label;

      segments.push({ text, raw: token.raw });
    } else if (token.type === 'codespan') {
      segments.push({ text: 'code', raw: token.raw });
    } else if (token.type === 'image' || token.type === 'html') {
      segments.push({ text: '', raw: token.raw });
    } else if (token.type === 'br') {
      segments.push({ text: ' ', raw: token.raw });
    } else if (token.type === 'text' || token.type === 'escape') {
      segments.push({ text: token.text.replaceAll('\n', ' '), raw: token.raw });
    } else {
      segments.push(...segmentsOf(childTokens(token)));
    }
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
    if (token.type === 'paragraph' || token.type === 'heading') {
      blocks.push({ startLine: line, tokens: childTokens(token) });
    } else if (token.type === 'text') {
      // A tight list item holds its paragraph as one text token.
      const children = childTokens(token);
      const blockTokens = children.length > 0 ? children : [token];

      blocks.push({ startLine: line, tokens: blockTokens });
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
  let line = blockLine;

  for (const segment of segments) {
    if (position + segment.text.length > start) {
      break;
    }

    line += newlineCount(segment.raw);
    position += segment.text.length;
  }

  return line;
};

const sentenceSpans = (text: string): { text: string; start: number }[] => {
  const spans: { text: string; start: number }[] = [];
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

  return sentenceSpans(text).map((span) => ({
    text: span.text,
    line: lineAt(segments, span.start, block.startLine),
    words: countWords(span.text),
  }));
};

export const proseSentences = (markdown: string): ProseSentence[] => {
  const blocks: ProseBlock[] = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The default marked lexer emits marked token shapes.
  const tokens = lexer.lexer(markdown.replaceAll('\r\n', '\n')) as readonly MarkedToken[];

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
