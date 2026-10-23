import type { Gap } from './capture.js';
import type { Freshness } from './freshness.js';
import { readQuoted } from './gitQuotedName.js';
import type { PinnedTarget } from './target.js';

export type EvidenceList = 'paths' | 'tests' | 'callers' | 'markers' | 'rules' | 'checks';

export type NamedSection = 'rules' | 'checks';

export interface NamedPath {
  path: string;
  status: 'readable' | 'missing' | 'unreadable';
}

export type EvidenceGap =
  | Gap
  | { kind: 'freshness'; status: 'stale' | 'unknown'; reasons: string[] }
  | { kind: 'incompleteCapture'; reasons: string[] }
  | { kind: 'evidenceMismatch'; recordedHash: string; evidenceHash: string }
  | { kind: 'truncatedList'; list: EvidenceList; path?: string; kept: number; total: number }
  | {
      kind: 'truncatedBody';
      path: string;
      limit: 'lines' | 'characters';
      kept: number;
      total: number;
    }
  | { kind: 'truncatedLine'; path: string; line: number; kept: number; total: number }
  | { kind: 'missing'; path: string; section: NamedSection }
  | { kind: 'unsearched'; path: string; reason: string }
  | { kind: 'incompleteSearch'; path: string; reason: string };

export interface EvidenceLimits {
  paths: number;
  testFiles: number;
  bodyLines: number;
  bodyCharacters: number;
  callersPerModule: number;
  callers: number;
  callerLineCharacters: number;
  namedPaths: number;
  markers: number;
}

export interface BodyLimits {
  lines: number;
  characters: number;
}

export interface NumberedLine {
  line: number;
  text: string;
}

export interface MarkerLine {
  path: string;
  // The line number in the new file.
  line: number;
  marker: string;
  text: string;
}

interface HunkState {
  oldRemaining: number;
  newRemaining: number;
  newLine: number;
}

interface Bounded<T> {
  items: T[];
  gaps: EvidenceGap[];
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

type GrepRecord = { match: GrepMatch; next: number; error?: undefined } | { error: string };

export interface FreshnessGapFacts {
  freshness: Freshness;
  recordedHash: string;
  // The hash of the capture the evidence was read from, taken after the freshness check.
  evidenceHash: string;
}

export const defaultEvidenceLimits: EvidenceLimits = {
  paths: 500,
  testFiles: 30,
  bodyLines: 400,
  bodyCharacters: 40_000,
  callersPerModule: 20,
  callers: 200,
  callerLineCharacters: 500,
  namedPaths: 50,
  markers: 200,
};

const fatalExitCode = 128;

const missingInCommit =
  /^fatal: path '[^]*' (?:does not exist|exists on disk, but not) in '[^]*'$/mu;

export const committedPathStatus = (
  exitCode: number | null,
  stderr: string,
): NamedPath['status'] => {
  if (exitCode === 0) {
    return 'readable';
  }

  return exitCode === fatalExitCode && missingInCommit.test(stderr) ? 'missing' : 'unreadable';
};

const scriptExtension = /\.[cm]?[jt]sx?$/;
const testSuffix = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const isTestPath = (path: string): boolean => testSuffix.test(path);

const isDeclaration = (path: string) => /\.d\.[cm]?ts$/.test(path);

export const isSourcePath = (path: string): boolean =>
  scriptExtension.test(path) && !isTestPath(path) && !isDeclaration(path);

const siblingTestPath = (path: string) =>
  path.replace(scriptExtension, (extension) => `.test${extension}`);

// The changed test files first, then the sibling test of each changed source file.
export const testPaths = (
  changed: readonly string[],
): { changed: string[]; siblings: string[] } => {
  const tests = changed.filter((path) => isTestPath(path));
  const siblings = changed.filter((path) => isSourcePath(path)).map(siblingTestPath);

  return { changed: tests, siblings: siblings.filter((path) => !tests.includes(path)) };
};

// A commit target holds its source at one commit; a working tree target holds it in the checkout.
export const sourceRevision = (target: PinnedTarget): string | undefined => {
  if (target.kind === 'range') {
    return target.to;
  }

  if (target.kind === 'rootCommit') {
    return target.commit;
  }

  return undefined;
};

const withoutScriptExtension = (path: string) => path.replace(scriptExtension, '');

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

const lastSegment = (path: string) => path.split('/').at(-1) ?? path;

// A `..` without a directory to leave stays in the path, so a path that escapes the repository
// never equals a module inside it.
const normalizePath = (path: string) => {
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    const leavesDirectory = segment === '..' && segments.length > 0 && segments.at(-1) !== '..';

    if (leavesDirectory) {
      segments.pop();
    } else if (segment !== '.' && segment !== '') {
      segments.push(segment);
    }
  }

  return segments.join('/');
};

// A relative specifier after `import ... from` or `export ... from` that starts a statement, after a
// `} from` that starts the line and closes a multi-line import, after a side-effect `import` that
// starts a statement, or inside `import(` or `require(`.
const importSyntax =
  /(?:(?:^|;)\s*(?:(?:import|export)\b[^'"]*?\bfrom|import)|^\s*\}\s*from|\b(?:import|require)\s*\()\s*(['"])(\.{1,2}\/[^'"]*)\1/g;

const isCommentLine = (text: string) => /^\s*(?:\/\/|\/\*|\*)/.test(text);

const isQuote = (character: string) => character === '"' || character === "'" || character === '`';

// A trailing comment starts with `//` after whitespace. Without the whitespace, the slashes can end
// a regular expression such as `/\//`, so the line goes on as code.
const startsComment = (text: string, index: number) =>
  text.startsWith('//', index) && /\s/.test(text.charAt(index - 1));

// Cuts the line at a trailing comment outside a string.
const codeBeforeComment = (text: string) => {
  let quote: string | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);

    if (quote === undefined) {
      if (startsComment(text, index)) {
        return text.slice(0, index);
      }

      quote = isQuote(character) ? character : undefined;
    } else if (character === '\\') {
      index += 1;
    } else if (character === quote) {
      quote = undefined;
    }
  }

  return text;
};

const relativeSpecifiers = (text: string) =>
  isCommentLine(text)
    ? []
    : [...codeBeforeComment(text).matchAll(importSyntax)].map((match) => match[2] ?? '');

// The import names a module by its path with or without the extension. Only a path without an
// extension can name a directory by its index file.
const namesModule = (resolved: string, module: string) => {
  const stem = withoutScriptExtension(module);
  const isIndex = lastSegment(stem) === 'index';
  const hasExtension = scriptExtension.test(resolved);

  const namesDirectory = isIndex && !hasExtension && resolved === parentOf(stem);

  return withoutScriptExtension(resolved) === stem || namesDirectory;
};

export const importsModule = (importer: string, text: string, module: string): boolean =>
  relativeSpecifiers(text).some((specifier) => {
    const resolved = normalizePath(`${parentOf(importer)}/${specifier}`);

    return namesModule(resolved, module);
  });

const escapeExtendedPattern = (text: string) => text.replaceAll(/[.[\]()*+?{}|^$\\]/g, '\\$&');

// A POSIX extended pattern for `git grep -E` that finds every line that may import the module.
export const importPattern = (module: string): string => {
  const stem = withoutScriptExtension(module);
  const names = [lastSegment(stem)];

  if (lastSegment(stem) === 'index' && parentOf(stem) !== '') {
    names.push(lastSegment(parentOf(stem)));
  }

  const alternatives = names.map(escapeExtendedPattern).join('|');

  return `['"]\\.{1,2}/([^'"]*/)?(${alternatives})(\\.[a-z]+)?['"]`;
};

// git grep reads a newline in a pattern as a pattern separator, and no line can hold one.
export const isSearchable = (module: string): boolean => !importPattern(module).includes('\n');

export const isCaller = (importer: string, module: string): boolean =>
  importer !== module && !isTestPath(importer) && scriptExtension.test(importer);

const sectionText = (input: string, heading: string) => {
  const lines = input.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);

  if (start === -1) {
    return '';
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('#'));

  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

const isUrl = (reference: string) => /^[a-z][a-z0-9+.-]*:/i.test(reference);

// A code span or link target without whitespace names a path; prose and commands do not.
const references = (text: string) => {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? '');
  const candidates = [...spans, ...links].map((reference) => reference.replace(/#.*$/, ''));
  const paths = candidates.filter((path) => path !== '' && !/\s/.test(path) && !isUrl(path));

  return [...new Set(paths)];
};

export const namedPaths = (input: string): Record<NamedSection, string[]> => ({
  rules: references(sectionText(input, '## Rules')),
  checks: references(sectionText(input, '## Checks')),
});

export const boundList = <T>(
  items: readonly T[],
  limit: number,
  cut: { list: EvidenceList; path?: string },
): Bounded<T> => {
  if (items.length <= limit) {
    return { items: [...items], gaps: [] };
  }

  const gap: EvidenceGap = { kind: 'truncatedList', ...cut, kept: limit, total: items.length };

  return { items: items.slice(0, limit), gaps: [gap] };
};

// Keeps whole lines until the character budget runs out, then the start of the line that
// crosses it.
const cutAtCharacters = (lines: readonly string[], characters: number) => {
  const kept: string[] = [];
  let remaining = characters;

  for (const line of lines) {
    if (line.length > remaining) {
      const start = line.slice(0, remaining);

      return { kept: start === '' ? kept : [...kept, start], cut: true };
    }

    kept.push(line);
    remaining -= line.length;
  }

  return { kept, cut: false };
};

export const numberedBody = (
  path: string,
  text: string,
  limits: BodyLimits,
): { lines: NumberedLine[]; gaps: EvidenceGap[] } => {
  const withoutFinalNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  const all = withoutFinalNewline === '' ? [] : withoutFinalNewline.split('\n');
  const { kept, cut } = cutAtCharacters(all.slice(0, limits.lines), limits.characters);
  const lines = kept.map((line, index) => ({ line: index + 1, text: line }));
  const truncated = { kind: 'truncatedBody' as const, path, kept: kept.length, total: all.length };

  if (cut) {
    return { lines, gaps: [{ ...truncated, limit: 'characters' }] };
  }

  return { lines, gaps: all.length > limits.lines ? [{ ...truncated, limit: 'lines' }] : [] };
};

export const callerText = (
  { path, line, text }: GrepMatch,
  limit: number,
): { text: string; gaps: EvidenceGap[] } => {
  if (text.length <= limit) {
    return { text, gaps: [] };
  }

  const gap: EvidenceGap = { kind: 'truncatedLine', path, line, kept: limit, total: text.length };

  return { text: text.slice(0, limit), gaps: [gap] };
};

const lineNumber = /^[1-9]\d*$/;

// `git grep -z` prints `[<revision>:]<path>\0<line>\0<text>\n`. A path can hold a newline, so
// the NUL-terminated fields are read before the newline-terminated text.
const parseGrepRecord = (output: string, start: number, prefix: string): GrepRecord => {
  const nameEnd = output.indexOf('\0', start);
  const lineEnd = nameEnd === -1 ? -1 : output.indexOf('\0', nameEnd + 1);
  const textEnd = lineEnd === -1 ? -1 : output.indexOf('\n', lineEnd + 1);
  const name = output.slice(start, nameEnd);
  const line = output.slice(nameEnd + 1, lineEnd);
  const malformed = `git grep printed a malformed record: ${JSON.stringify(output.slice(start))}`;

  if (textEnd === -1 || !lineNumber.test(line)) {
    return { error: malformed };
  }

  if (!name.startsWith(prefix)) {
    return { error: malformed };
  }

  const match = { path: name.slice(prefix.length), line: Number(line) };

  return { match: { ...match, text: output.slice(lineEnd + 1, textEnd) }, next: textEnd + 1 };
};

export const parseGrepOutput = (
  output: string,
  revision: string | undefined,
): { matches: GrepMatch[]; error?: undefined } | { matches?: undefined; error: string } => {
  const prefix = revision === undefined ? '' : `${revision}:`;
  const matches: GrepMatch[] = [];
  let offset = 0;

  while (offset < output.length) {
    const record = parseGrepRecord(output, offset, prefix);

    if (record.error !== undefined) {
      return { error: record.error };
    }

    matches.push(record.match);
    offset = record.next;
  }

  return { matches };
};

// The target can change between the freshness check and the evidence capture, so a fresh result
// alone does not show that the evidence matches the saved capture.
export const freshnessGaps = ({
  freshness: { status, reasons },
  recordedHash,
  evidenceHash,
}: FreshnessGapFacts): EvidenceGap[] => {
  const gaps: EvidenceGap[] = [];

  if (status !== 'fresh') {
    gaps.push({ kind: 'freshness', status, reasons });
  }

  if (evidenceHash !== recordedHash) {
    gaps.push({ kind: 'evidenceMismatch', recordedHash, evidenceHash });
  }

  return gaps;
};

const skipMarkers = [
  '.skip(',
  '.only(',
  '.todo(',
  '@ts-ignore',
  '@ts-expect-error',
  'eslint-disable',
  'oxlint-disable',
];

const markdownPath = /\.(?:md|mdx|markdown)$/i;

const hunkHeader = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const fileHeader = '+++ ';

// The new-side path of a `+++ ` header line, without the prefix. Undefined for /dev/null.
const headerPath = (text: string): string | undefined => {
  const name = text.startsWith('"') ? readQuoted(text).name : (text.split('\t')[0] ?? '');

  if (name === '/dev/null') {
    return undefined;
  }

  return name.startsWith('b/') ? name.slice(2) : name;
};

const firstMarker = (text: string) => skipMarkers.find((marker) => text.includes(marker));

const resetHunk = (hunk: HunkState) => {
  hunk.oldRemaining = 0;
  hunk.newRemaining = 0;
};

// Moves the hunk past one line. Returns the added line, 'consumed' for any other line of the
// hunk, or 'outside' when the line is not part of a hunk.
const consumeHunkLine = (
  hunk: HunkState,
  line: string,
): { line: number; text: string } | 'consumed' | 'outside' => {
  const kind = line[0] ?? ' ';

  if (hunk.oldRemaining <= 0 && hunk.newRemaining <= 0) {
    return 'outside';
  }

  if (kind === '+') {
    const added = { line: hunk.newLine, text: line.slice(1) };

    hunk.newRemaining -= 1;
    hunk.newLine += 1;

    return added;
  }

  if (kind === '-') {
    hunk.oldRemaining -= 1;

    return 'consumed';
  }

  if (kind === ' ') {
    hunk.oldRemaining -= 1;
    hunk.newRemaining -= 1;
    hunk.newLine += 1;

    return 'consumed';
  }

  return kind === '\\' ? 'consumed' : 'outside';
};

// Reads a line outside a hunk. Returns the new file path, possibly undefined, when the line sets
// one, and nothing when the line leaves the path unchanged.
const readHeaderLine = (
  hunk: HunkState,
  line: string,
): { path: string | undefined } | undefined => {
  const header = hunkHeader.exec(line);

  if (header !== null) {
    hunk.oldRemaining = Number(header[1] ?? 1);
    hunk.newRemaining = Number(header[3] ?? 1);
    hunk.newLine = Number(header[2]);

    return undefined;
  }

  if (line.startsWith(fileHeader)) {
    resetHunk(hunk);

    return { path: headerPath(line.slice(fileHeader.length)) };
  }

  if (line.startsWith('diff --git ')) {
    resetHunk(hunk);

    return { path: undefined };
  }

  return undefined;
};

// Lists the added lines that hold a skip or suppression marker. The hunk header counts decide
// where a hunk ends, so an added line that starts with `++` is never read as a file header.
export const scanMarkers = (
  diff: string,
  limits: Pick<EvidenceLimits, 'markers' | 'callerLineCharacters'> = defaultEvidenceLimits,
): Bounded<MarkerLine> => {
  const found: MarkerLine[] = [];
  const hunk: HunkState = { oldRemaining: 0, newRemaining: 0, newLine: 0 };
  let path: string | undefined;

  for (const line of diff.split('\n')) {
    const consumed = consumeHunkLine(hunk, line);

    if (consumed === 'outside') {
      const header = readHeaderLine(hunk, line);

      if (header !== undefined) {
        ({ path } = header);
      }
    } else if (consumed !== 'consumed') {
      const marker = firstMarker(consumed.text);

      if (path !== undefined && marker !== undefined && !markdownPath.test(path)) {
        found.push({ path, line: consumed.line, marker, text: consumed.text });
      }
    }
  }

  const bounded = boundList(found, limits.markers, { list: 'markers' });
  const cuts = bounded.items.map((item) => callerText(item, limits.callerLineCharacters));

  return {
    items: bounded.items.map((item, index) => ({ ...item, text: cuts[index]?.text ?? item.text })),
    gaps: [...cuts.flatMap((cut) => cut.gaps), ...bounded.gaps],
  };
};

const wholeFileHunk = /^@@ -0,0 \+1(?:,(\d+))? @@/;

// Rewrites the whole-file diff of a file the base already holds so that only the lines the base
// text lacks stay added. A line counts as added when it occurs more often than in the base text.
// The other lines become context lines, so the new-side line numbers stay the same.
export const keepAddedLines = (section: string, baseText: string): string => {
  const lines = section.split('\n');
  const start = lines.findIndex((line) => wholeFileHunk.test(line));

  if (start === -1) {
    return section;
  }

  const remaining = new Map<string, number>();

  for (const line of baseText.replace(/\n$/, '').split('\n')) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }

  const count = Number(wholeFileHunk.exec(lines[start] ?? '')?.[1] ?? 1);

  const body = lines.slice(start + 1, start + 1 + count).map((line) => {
    const text = line.slice(1);
    const left = remaining.get(text) ?? 0;

    if (left === 0) {
      return line;
    }

    remaining.set(text, left - 1);

    return ` ${text}`;
  });

  const contextCount = body.filter((line) => line.startsWith(' ')).length;
  const oldStart = contextCount === 0 ? 0 : 1;

  return [
    ...lines.slice(0, start),
    `@@ -${oldStart},${contextCount} +1,${count} @@`,
    ...body,
    ...lines.slice(start + 1 + count),
  ].join('\n');
};
