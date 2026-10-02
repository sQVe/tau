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
const queryPattern = new RegExp(`${tokenStart}#(${idCharacters}*)$`, 'u');

const fenceOpenPattern = /^ {0,3}(`{3,}|~{3,})/;
const fenceClosePattern = /^ {0,3}(`{3,}|~{3,})[\t ]*$/;
const backtickRunPattern = /`+/g;

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
