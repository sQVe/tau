interface BraceGroup {
  close: number;
  commas: number[];
}

interface Segment {
  text: string;
  test: (name: string) => boolean;
}

type Pattern = Segment[];

export interface InputRules {
  entersDirectory: (name: string, path: string) => boolean;
  isInput: (path: string) => boolean;
}

const maxRangeValues = 1000;

const maxExpansions = 1000;

const leadingCurrentDirectory = /^(?:\.\/)+/u;

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

const wildcardExpressions: Record<string, string> = { '*': '.*', '?': '.' };

const escapeLiteral = (character: string) => character.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&');

const toRegularExpression = (source: string): RegExp => {
  const expression = source
    .split('')
    .map((character) => wildcardExpressions[character] ?? escapeLiteral(character))
    .join('');

  return new RegExp(`^${expression}$`, 's');
};

const compileSegment = (text: string): Segment => {
  const isWildcard = /[*?]/u.test(text);

  if (!isWildcard) {
    return { text, test: (name) => name === text };
  }

  const expression = toRegularExpression(text);

  return { text, test: (name) => expression.test(name) };
};

const compileGlobs = (globs: string[]): Pattern[] =>
  globs
    .flatMap((glob) => expandBraces(glob, maxExpansions) ?? [])
    .map((alternative) =>
      alternative.replace(leadingCurrentDirectory, '').split('/').map(compileSegment),
    );

// `**` matches zero or more segments, but never crosses a dot segment unless `matchesDots` is
// set. `first` is the fewest segments it must consume.
const matchesGlobstar = (
  path: string[],
  matchesDots: boolean,
  first: number,
  matchesRest: (remaining: string[]) => boolean,
): boolean => {
  for (let skipped = 0; skipped <= path.length; skipped++) {
    const canStop = skipped >= first && matchesRest(path.slice(skipped));

    if (canStop) {
      return true;
    }

    const crossesDot = !matchesDots && path[skipped]?.startsWith('.') === true;

    if (crossesDot) {
      return false;
    }
  }

  return false;
};

// A dot segment matches only a pattern segment that starts with a literal dot, unless
// `matchesDots` is set. A trailing `**` needs at least one segment.
const matchesSegments = (pattern: Pattern, path: string[], matchesDots: boolean): boolean => {
  const [head, ...rest] = pattern;

  if (head === undefined) {
    return path.length === 0;
  }

  if (head.text === '**') {
    const matchesRest = (remaining: string[]) => matchesSegments(rest, remaining, matchesDots);

    return matchesGlobstar(path, matchesDots, rest.length === 0 ? 1 : 0, matchesRest);
  }

  const [name, ...remaining] = path;

  if (name === undefined) {
    return false;
  }

  const dotAllowed = matchesDots || !name.startsWith('.') || head.text.startsWith('.');

  return dotAllowed && head.test(name) && matchesSegments(rest, remaining, matchesDots);
};

// A pattern ending in `/**` also excludes the directory it names, and so every descendant.
const excludesDirectory = (excludes: Pattern[], segments: string[]) =>
  excludes.some((pattern) => {
    const isTree = pattern.at(-1)?.text === '**';
    const treeRoot = pattern.slice(0, -1);

    const matchesTree = isTree && matchesSegments(treeRoot, segments, true);

    return matchesSegments(pattern, segments, true) || matchesTree;
  });

// A directory whose real path is one of its own ancestors would repeat the walk forever.
export const closesLoop = (realPath: string, ancestorRealPaths: ReadonlySet<string>): boolean =>
  ancestorRealPaths.has(realPath);

// Builds the decisions of one directory walk. Assumes every glob passed `unsupportedGlobReason`.
// With `matchesDots`, a dot path matches like `node:path` `matchesGlob`; the walk leaves it off.
export const createInputRules = (
  includeGlobs: string[],
  excludedGlobs: string[],
  matchesDots = false,
): InputRules => {
  const patterns = compileGlobs(includeGlobs);
  const excludes = compileGlobs(excludedGlobs);

  const dotSegments = patterns
    .flat()
    .filter((segment) => segment.text.startsWith('.') && segment.text !== '.');

  const namesDot = (name: string) => dotSegments.some((segment) => segment.test(name));

  const namesDirectory = (name: string) => !name.startsWith('.') || namesDot(name);

  return {
    entersDirectory: (name, path) =>
      namesDirectory(name) && !excludesDirectory(excludes, path.split('/')),
    isInput: (path) => {
      const segments = path.split('/');
      const directories = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1));

      const isExcluded =
        excludes.some((pattern) => matchesSegments(pattern, segments, true)) ||
        directories.some((directory) => excludesDirectory(excludes, directory));

      return (
        !isExcluded && patterns.some((pattern) => matchesSegments(pattern, segments, matchesDots))
      );
    },
  };
};
