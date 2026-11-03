import { Minimatch } from 'minimatch';

interface BraceGroup {
  close: number;
  commas: number[];
}

export interface InputRules {
  entersDirectory: (path: string) => boolean;
  isInput: (path: string) => boolean;
}

const maxRangeValues = 1000;

const maxExpansions = 1000;

const leadingCurrentDirectory = /^(?:\.\/)+/u;

const matcherOptions = { dot: true, nonegate: true, nocomment: true, noext: true };

const numericRange = /^(-?\d+)\.\.(-?\d+)$/u;

const extendedGlobOpener = /[?*+@!]\(/u;

const findBraceGroup = (pattern: string, open: number): BraceGroup | null => {
  let depth = 0;
  const commas: number[] = [];

  for (let index = open; index < pattern.length; index++) {
    const character = pattern[index];

    if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
    } else if (character === ',' && depth === 1) {
      commas.push(index);
    }

    if (depth === 0) {
      return { close: index, commas };
    }
  }

  return null;
};

const hasStrayClosingBrace = (glob: string) => {
  let depth = 0;

  for (const character of glob) {
    depth += character === '{' ? 1 : 0;
    depth -= character === '}' ? 1 : 0;

    if (depth < 0) {
      return true;
    }
  }

  return false;
};

const rangeProblem = (inner: string): string | null => {
  const bounds = numericRange.exec(inner);

  if (bounds === null) {
    return `the range {${inner}} is not made of integers; only numeric ranges such as {1..3} are supported`;
  }

  const [first = '', last = ''] = [bounds[1], bounds[2]];

  if (first.startsWith('-') || last.startsWith('-')) {
    return `the range {${inner}} has a negative bound; only non-negative integers are supported`;
  }

  if ([first, last].some((bound) => bound.length > 1 && bound.startsWith('0'))) {
    return `the range {${inner}} is zero-padded; write the bounds without leading zeros`;
  }

  if (![first, last].every((bound) => Number.isSafeInteger(Number(bound)))) {
    return `the range {${inner}} has a bound beyond the largest safe integer`;
  }

  const values = Math.abs(Number(last) - Number(first)) + 1;

  return values > maxRangeValues
    ? `the range {${inner}} has ${values} values; a range may have at most ${maxRangeValues}`
    : null;
};

const braceGroupProblem = (glob: string, open: number): string | null => {
  const group = findBraceGroup(glob, open);

  if (group === null) {
    return 'it has an unclosed "{"';
  }

  const inner = glob.slice(open + 1, group.close);

  if (inner === '') {
    return 'it has an empty brace group "{}"';
  }

  if (group.commas.length > 0) {
    return null;
  }

  return inner.includes('..')
    ? rangeProblem(inner)
    : `the brace group {${inner}} has no comma and is not a range`;
};

const firstBraceProblem = (glob: string): string | null => {
  for (let index = 0; index < glob.length; index++) {
    const problem = glob[index] === '{' ? braceGroupProblem(glob, index) : null;

    if (problem !== null) {
      return problem;
    }
  }

  return null;
};

const rangeValues = (inner: string): string[] | null => {
  const bounds = numericRange.exec(inner);

  if (bounds === null) {
    return null;
  }

  const first = Number(bounds[1]);
  const last = Number(bounds[2]);
  const low = Math.min(first, last);

  return Array.from({ length: Math.abs(last - first) + 1 }, (_, offset) => String(low + offset));
};

const braceAlternatives = (glob: string, open: number, group: BraceGroup): string[] => {
  const inner = glob.slice(open + 1, group.close);

  if (group.commas.length === 0) {
    return rangeValues(inner) ?? [];
  }

  const edges = [open, ...group.commas, group.close];

  return edges.slice(0, -1).map((start, index) => glob.slice(start + 1, edges[index + 1]));
};

// Expands the first brace group recursively. Returns null when the glob expands to more than
// `limit` patterns. Assumes the glob passed `unsupportedGlobReason`.
const expandBraces = (glob: string, limit: number): string[] | null => {
  const open = glob.indexOf('{');

  if (open === -1) {
    return [glob];
  }

  const group = findBraceGroup(glob, open);
  const alternatives = group === null ? [] : braceAlternatives(glob, open, group);
  const prefix = glob.slice(0, open);
  const suffix = glob.slice((group?.close ?? open) + 1);
  const expanded: string[] = [];

  for (const alternative of alternatives) {
    const rest = expandBraces(`${prefix}${alternative}${suffix}`, limit - expanded.length);

    if (rest === null) {
      return null;
    }

    expanded.push(...rest);

    if (expanded.length > limit) {
      return null;
    }
  }

  return expanded;
};

const segmentProblem = (alternative: string): string | null => {
  const segments = alternative.replace(leadingCurrentDirectory, '').split('/');

  if (segments.includes('')) {
    return `it expands to "${alternative}", which has an empty path segment`;
  }

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return `it expands to "${alternative}", which has a "." or ".." path segment`;
  }

  return null;
};

// Returns what makes `glob` unsupported, or null. Tau supports literal segments, `*`, `**`, `?`,
// comma brace groups, numeric ranges, and a leading `./`.
export const unsupportedGlobReason = (glob: string): string | null => {
  if (glob.includes('\\')) {
    return 'it has a backslash escape, which is not supported';
  }

  if (/[[\]]/u.test(glob)) {
    return 'it has a bracket class "[" or "]", which is not supported';
  }

  if (extendedGlobOpener.test(glob)) {
    return 'it has an extended glob such as "+(...)", which is not supported';
  }

  if (hasStrayClosingBrace(glob)) {
    return 'it has a "}" without a matching "{"';
  }

  const braceProblem = firstBraceProblem(glob);

  if (braceProblem !== null) {
    return braceProblem;
  }

  const alternatives = expandBraces(glob, maxExpansions);

  if (alternatives === null) {
    return `its braces expand to more than ${maxExpansions} patterns in total; a glob may expand to at most ${maxExpansions}`;
  }

  return alternatives.map(segmentProblem).find((problem) => problem !== null) ?? null;
};

const compileAlternative = (alternative: string): Minimatch =>
  new Minimatch(alternative.replace(leadingCurrentDirectory, ''), matcherOptions);

const expandGlobs = (globs: string[]): string[] =>
  globs.flatMap((glob) => expandBraces(glob, maxExpansions) ?? []);

const treeSuffix = '/**';

// A pattern ending in `/**` also excludes the directory it names, and so every descendant.
const compileExclude = (alternative: string) => {
  const matcher = compileAlternative(alternative);

  const treeRoot = alternative.endsWith(treeSuffix)
    ? compileAlternative(alternative.slice(0, -treeSuffix.length))
    : null;

  return {
    matches: (path: string) => matcher.match(path),
    matchesDirectory: (path: string) => matcher.match(path) || treeRoot?.match(path) === true,
  };
};

// A directory whose real path is one of its own ancestors would repeat the walk forever.
export const closesLoop = (realPath: string, ancestorRealPaths: ReadonlySet<string>): boolean =>
  ancestorRealPaths.has(realPath);

export const createInputRules = (includeGlobs: string[], excludedGlobs: string[]): InputRules => {
  const patterns = expandGlobs(includeGlobs).map(compileAlternative);
  const excludes = expandGlobs(excludedGlobs).map(compileExclude);

  const isExcludedDirectory = (directory: string) =>
    excludes.some((rule) => rule.matchesDirectory(directory));

  return {
    entersDirectory: (path) => !isExcludedDirectory(path),
    isInput: (path) => {
      const segments = path.split('/');

      const ancestors = segments
        .slice(0, -1)
        .map((_, index) => segments.slice(0, index + 1).join('/'));

      const isExcludedFile = excludes.some((rule) => rule.matches(path));
      const isInExcludedDirectory = ancestors.some(isExcludedDirectory);

      return (
        !isExcludedFile && !isInExcludedDirectory && patterns.some((pattern) => pattern.match(path))
      );
    },
  };
};
