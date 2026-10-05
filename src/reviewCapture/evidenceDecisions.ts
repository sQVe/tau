import type { Freshness } from './freshness.js';
import type { Gap, PinnedTarget } from './reviewCapture.js';

export type EvidenceList = 'paths' | 'tests' | 'callers' | 'rules' | 'checks';

export type NamedSection = 'rules' | 'checks';

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
  | { kind: 'absent'; path: string }
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
}

export interface BodyLimits {
  lines: number;
  characters: number;
}

export interface NumberedLine {
  line: number;
  text: string;
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

const normalizePath = (path: string) => {
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    if (segment === '..') {
      segments.pop();
    } else if (segment !== '.' && segment !== '') {
      segments.push(segment);
    }
  }

  return segments.join('/');
};

// A relative specifier after `from`, a side-effect `import`, `import(`, or `require(`.
const importSyntax =
  /(?:(?:^|[\s}])from|^\s*import|\bimport\s*\(|\brequire\s*\()\s*(['"])(\.{1,2}\/[^'"]*)\1/g;

const isCommentLine = (text: string) => /^\s*(?:\/\/|\/\*|\*)/.test(text);

const relativeSpecifiers = (text: string) =>
  isCommentLine(text) ? [] : [...text.matchAll(importSyntax)].map((match) => match[2] ?? '');

// The import names a module by its path without the extension, or a directory by its index file.
const namesModule = (resolved: string, module: string) => {
  const stem = withoutScriptExtension(module);
  const isIndex = lastSegment(stem) === 'index';

  const namesDirectory = isIndex && resolved === parentOf(stem);

  return resolved === stem || namesDirectory;
};

export const importsModule = (importer: string, text: string, module: string): boolean =>
  relativeSpecifiers(text).some((specifier) => {
    const resolved = normalizePath(`${parentOf(importer)}/${specifier}`);

    return namesModule(withoutScriptExtension(resolved), module);
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
