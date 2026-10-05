import type { Freshness } from './freshness.js';
import type { Gap, PinnedTarget } from './reviewCapture.js';

export type EvidenceList = 'paths' | 'tests' | 'callers' | 'rules' | 'checks';

export type NamedSection = 'rules' | 'checks';

export type EvidenceGap =
  | Gap
  | { kind: 'freshness'; status: 'stale' | 'unknown'; reasons: string[] }
  | { kind: 'incompleteCapture'; reasons: string[] }
  | { kind: 'truncatedList'; list: EvidenceList; path?: string; kept: number; total: number }
  | { kind: 'truncatedBody'; path: string; kept: number; total: number }
  | { kind: 'absent'; path: string }
  | { kind: 'missing'; path: string; section: NamedSection }
  | { kind: 'unsearched'; path: string; reason: string };

export interface EvidenceLimits {
  paths: number;
  testFiles: number;
  bodyLines: number;
  callersPerModule: number;
  callers: number;
  namedPaths: number;
}

export interface NumberedLine {
  line: number;
  text: string;
}

interface Bounded<T> {
  items: T[];
  gaps: EvidenceGap[];
}

export const defaultEvidenceLimits: EvidenceLimits = {
  paths: 500,
  testFiles: 30,
  bodyLines: 400,
  callersPerModule: 20,
  callers: 200,
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

const relativeSpecifiers = (text: string) =>
  [...text.matchAll(/['"](\.{1,2}\/[^'"]*)['"]/g)].map((match) => match[1] ?? '');

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

export const numberedBody = (
  path: string,
  text: string,
  limit: number,
): { lines: NumberedLine[]; gaps: EvidenceGap[] } => {
  const withoutFinalNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  const all = withoutFinalNewline === '' ? [] : withoutFinalNewline.split('\n');
  const lines = all.slice(0, limit).map((line, index) => ({ line: index + 1, text: line }));

  const gaps: EvidenceGap[] =
    all.length > limit ? [{ kind: 'truncatedBody', path, kept: limit, total: all.length }] : [];

  return { lines, gaps };
};

export const freshnessGaps = ({ status, reasons }: Freshness): EvidenceGap[] =>
  status === 'fresh' ? [] : [{ kind: 'freshness', status, reasons }];
