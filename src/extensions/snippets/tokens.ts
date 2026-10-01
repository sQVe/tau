import type { Snippet, SnippetPlacement } from './types.js';

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
 * and both require the command at the start of the text. Wrapping the text
 * would leave the command unexpanded, or turn an appended body into its
 * arguments, so snippets never apply to a message that starts with a slash.
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

  return (result + text.slice(position)).trim();
};

/** Whether `text` holds a token for any id, so the caller knows to load snippets. */
export const mayHoldTokens = (text: string) => acceptsSnippets(text) && findTokens(text).length > 0;

/**
 * Returns the snippets whose tokens appear in `text`, once each and in the
 * order of `snippets`. A slash command has none.
 */
export const activeSnippets = (text: string, snippets: Snippet[]): Snippet[] => {
  if (!acceptsSnippets(text)) {
    return [];
  }

  const ids = new Set(knownTokens(text, snippets).map((token) => token.id));

  return snippets.filter((snippet) => ids.has(snippet.id));
};

/**
 * Removes the snippet tokens from `text` and wraps the rest with their bodies.
 * `snippets` must already be sorted. Returns undefined when `text` has no
 * known token or is a slash command, so it is sent unchanged.
 */
export const expandSnippets = (text: string, snippets: Snippet[]): string | undefined => {
  if (!acceptsSnippets(text)) {
    return undefined;
  }

  const tokens = knownTokens(text, snippets);

  if (tokens.length === 0) {
    return undefined;
  }

  const ids = new Set(tokens.map((token) => token.id));
  const active = snippets.filter((snippet) => ids.has(snippet.id));

  const bodiesFor = (placement: SnippetPlacement) =>
    active.filter((snippet) => snippet.placement === placement).map((snippet) => snippet.body);

  return [...bodiesFor('prepend'), removeTokens(text, tokens), ...bodiesFor('append')]
    .filter((part) => part !== '')
    .join('\n\n');
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
