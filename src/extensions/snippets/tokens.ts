import type { Snippet } from './types.js';

interface TokenMatch {
  id: string;
  start: number;
  end: number;
}

interface Range {
  start: number;
  end: number;
}

interface Fences {
  fenced: Range[];
  prose: Range[];
}

// Copies the token boundary of pi-tui's editor, which is not exported. A token starts at the start
// of the text or after whitespace or CJK punctuation, and opening brackets or a backtick may come
// before the `#`, as in `(#simplify`.
const cjkBreak =
  '[\\p{Script_Extensions=Han}\\p{Script_Extensions=Hiragana}\\p{Script_Extensions=Katakana}\\p{Script_Extensions=Hangul}\\p{Script_Extensions=Bopomofo}]';

const cjkPunctuation = `(?:(?=\\p{Punctuation})${cjkBreak}|[，．：；！？（）［］｛｝“”‘’…—])`;
const tokenStart = `(?<=^|\\s|${cjkPunctuation})[([{<\`]*`;
const idCharacters = '[\\p{L}\\p{N}_-]';
const tokenPattern = new RegExp(`${tokenStart}#(${idCharacters}+)`, 'gu');
const queryPattern = new RegExp(`${tokenStart}#(${idCharacters}*)$`, 'u');
const idPattern = new RegExp(`^${idCharacters}+$`, 'u');

const fenceOpenPattern = /^ {0,3}(`{3,}|~{3,})/;
const fenceClosePattern = /^ {0,3}(`{3,}|~{3,})[\t ]*$/;
const backtickRunPattern = /`+/g;

/** Whether `id` can follow a `#` as a token. Other snippet files cannot be used as tokens. */
export const isTokenId = (id: string) => idPattern.test(id);

/**
 * Pi expands `/skill:name` and prompt templates after the input handlers run,
 * and both require the command at the start of the text. An expanded token
 * would become part of the command's arguments, so snippets never apply to a
 * message that starts with a slash.
 */
export const acceptsSnippets = (text: string) => !text.trimStart().startsWith('/');

const closesFence = (line: string, fence: string) => {
  const close = fenceClosePattern.exec(line)?.[1];

  return close?.startsWith(fence.charAt(0)) === true && close.length >= fence.length;
};

const splitFences = (text: string): Fences => {
  const fenced: Range[] = [];
  const prose: Range[] = [];
  let fence: string | undefined;
  let blockStart = 0;
  let proseStart = 0;
  let lineStart = 0;

  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length;

    if (fence === undefined) {
      const open = fenceOpenPattern.exec(line)?.[1];

      if (open !== undefined) {
        fence = open;
        blockStart = lineStart;
        prose.push({ start: proseStart, end: lineStart });
      }
    } else if (closesFence(line, fence)) {
      fence = undefined;
      fenced.push({ start: blockStart, end: lineEnd });
      proseStart = lineEnd;
    }

    lineStart = lineEnd + 1;
  }

  if (fence === undefined) {
    prose.push({ start: proseStart, end: text.length });
  } else {
    fenced.push({ start: blockStart, end: text.length });
  }

  return { fenced, prose };
};

const closingRun = (runs: RegExpExecArray[], open: RegExpExecArray, openIndex: number) =>
  runs.findIndex((run, index) => index > openIndex && run[0] === open[0]);

// A run of backticks opens a code span only when a later run of the same length closes it.
const inlineCodeRanges = (text: string, prose: Range): Range[] => {
  const ranges: Range[] = [];
  const runs = [...text.slice(prose.start, prose.end).matchAll(backtickRunPattern)];
  let openIndex = 0;

  while (openIndex < runs.length) {
    const open = runs[openIndex];
    const closeIndex = open === undefined ? -1 : closingRun(runs, open, openIndex);
    const close = runs[closeIndex];

    if (open === undefined || close === undefined) {
      openIndex += 1;

      continue;
    }

    ranges.push({
      start: prose.start + open.index,
      end: prose.start + close.index + close[0].length,
    });

    openIndex = closeIndex + 1;
  }

  return ranges;
};

const codeRanges = (text: string): Range[] => {
  const { fenced, prose } = splitFences(text);

  return [...fenced, ...prose.flatMap((range) => inlineCodeRanges(text, range))];
};

const isInCode = (ranges: Range[], offset: number) =>
  ranges.some((range) => offset >= range.start && offset < range.end);

const findTokens = (text: string): TokenMatch[] => {
  const code = codeRanges(text);
  const tokens: TokenMatch[] = [];

  for (const match of text.matchAll(tokenPattern)) {
    const id = match[1] ?? '';
    const end = match.index + match[0].length;
    const start = end - id.length - 1;

    if (!isInCode(code, start)) {
      tokens.push({ id, start, end });
    }
  }

  return tokens;
};

const knownTokens = (text: string, snippets: Snippet[]) => {
  const ids = new Set(snippets.map((snippet) => snippet.id));

  return findTokens(text).filter((token) => ids.has(token.id));
};

const skipBlanks = (text: string, position: number) => {
  let next = position;

  while (text[next] === ' ' || text[next] === '\t') {
    next += 1;
  }

  return next;
};

const endsLine = (character: string | undefined) => character === undefined || character === '\n';

// Blank lines at either end go, and so do blanks on the line that held a token. The
// indentation of a content line that starts after a newline stays, since it can be code.
const leadingBlanks = /^(?:[\t ]*\n)+|^[\t ]+/;
const trailingBlanks = /[\t ]*(?:\n[\t ]*)*$/;

const trimSegment = (text: string) => text.replace(leadingBlanks, '').replace(trailingBlanks, '');

const removeTokens = (text: string, tokens: TokenMatch[]) => {
  let result = '';
  let position = 0;

  for (const token of tokens) {
    result += text.slice(position, token.start);
    position = token.end;

    const standsAlone = result === '' || /\s$/.test(result);

    if (standsAlone) {
      position = skipBlanks(text, position);
    }

    if (endsLine(text[position])) {
      result = result.replace(/[\t ]+$/, '');
    }
  }

  return trimSegment(result + text.slice(position));
};

// Keeps the first token for each id and returns the later repeats separately.
const splitRepeats = (tokens: TokenMatch[]) => {
  const seen = new Set<string>();
  const first: TokenMatch[] = [];
  const repeated: TokenMatch[] = [];

  for (const token of tokens) {
    if (seen.has(token.id)) {
      repeated.push(token);

      continue;
    }

    seen.add(token.id);
    first.push(token);
  }

  return { first, repeated };
};

const isInside = (range: Range, token: TokenMatch) =>
  token.start >= range.start && token.end <= range.end;

// Returns the trimmed text in `range` without the repeated tokens it holds.
const textBetween = (text: string, range: Range, repeated: TokenMatch[]) => {
  const tokens = repeated
    .filter((token) => isInside(range, token))
    .map((token) => ({
      id: token.id,
      start: token.start - range.start,
      end: token.end - range.start,
    }));

  return removeTokens(text.slice(range.start, range.end), tokens);
};

/** Whether `text` holds a token for any id, so the caller knows to load snippets. */
export const mayHoldTokens = (text: string) => acceptsSnippets(text) && findTokens(text).length > 0;

/**
 * Returns the snippets whose tokens appear in `text`, once each and in token
 * order. A slash command has none.
 */
export const activeSnippets = (text: string, snippets: Snippet[]): Snippet[] => {
  if (!acceptsSnippets(text)) {
    return [];
  }

  const { first } = splitRepeats(knownTokens(text, snippets));
  const byId = new Map(snippets.map((snippet) => [snippet.id, snippet]));

  return first.flatMap((token) => byId.get(token.id) ?? []);
};

/**
 * Replaces the first token for each snippet with its body as its own block and
 * removes repeated tokens. Returns undefined when `text` has no known token or
 * is a slash command, so it is sent unchanged.
 */
export const expandSnippets = (text: string, snippets: Snippet[]): string | undefined => {
  if (!acceptsSnippets(text)) {
    return undefined;
  }

  const { first, repeated } = splitRepeats(knownTokens(text, snippets));

  if (first.length === 0) {
    return undefined;
  }

  const bodies = new Map(snippets.map((snippet) => [snippet.id, snippet.body]));
  const blocks: string[] = [];
  let position = 0;

  for (const token of first) {
    blocks.push(textBetween(text, { start: position, end: token.start }, repeated));
    blocks.push(bodies.get(token.id) ?? '');
    position = token.end;
  }

  blocks.push(textBetween(text, { start: position, end: text.length }, repeated));

  return blocks.filter((block) => block !== '').join('\n\n');
};

/**
 * Returns the snippet query typed before `offset`, such as `push` for
 * `#push`, or an empty query for a bare `#`. Returns undefined outside a
 * token and inside code.
 */
export const snippetQueryAt = (text: string, offset: number): string | undefined => {
  const query = queryPattern.exec(text.slice(0, offset))?.[1];

  if (query === undefined) {
    return undefined;
  }

  const start = offset - query.length - 1;

  return isInCode(codeRanges(text), start) ? undefined : query;
};
