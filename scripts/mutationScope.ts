export interface MutationScope {
  mutate: string[];
  include: string[];
  exclude: string[];
}

const extensionPattern = /^src\/extensions\/([^/]+)\//;

const hunkPattern = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;

const alwaysExcluded = ['**/node_modules/**', '**/*.integration.test.ts', '**/tau-lint-*/**'];

const coreTests = 'src/**/*.test.ts';

const isSourceFile = (path: string) => path.startsWith('src/') && path.endsWith('.ts');

const isProductionFile = (path: string) =>
  isSourceFile(path) && !path.endsWith('.test.ts') && !path.split('/').includes('fixtures');

// Reads the added line ranges of a zero-context diff. A hunk that adds no lines gives no range.
const addedRanges = (diff: string) => {
  const ranges: { path: string; start: number; end: number }[] = [];
  let path: string | undefined;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      path = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : undefined;

      continue;
    }

    const hunk = hunkPattern.exec(line);

    if (path === undefined || hunk === null) {
      continue;
    }

    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);

    if (count > 0) {
      ranges.push({ path, start, end: start + count - 1 });
    }
  }

  return ranges.filter(({ path: rangePath }) => isProductionFile(rangePath));
};

// A change under one extension runs that extension's tests. Any other source file runs the core
// tests. With both, the core pattern would also match extension tests, so no extension is excluded.
const testScope = (paths: string[]) => {
  const extensions = new Set<string>();
  let touchesCore = false;

  for (const path of paths) {
    const extension = extensionPattern.exec(path)?.[1];

    if (extension === undefined) {
      touchesCore = true;
    } else {
      extensions.add(extension);
    }
  }

  const extensionIncludes = [...extensions]
    .toSorted()
    .map((name) => `src/extensions/${name}/**/*.test.ts`);

  if (!touchesCore) {
    return { include: extensionIncludes, exclude: alwaysExcluded };
  }

  if (extensions.size > 0) {
    return { include: [coreTests], exclude: alwaysExcluded };
  }

  return { include: [coreTests], exclude: [...alwaysExcluded, 'src/extensions/**'] };
};

// Turns `git diff -U0` output into the lines to mutate and the tests that cover them.
// Undefined means the diff holds no production lines.
export const mutationScope = (diff: string): MutationScope | undefined => {
  const ranges = addedRanges(diff);

  if (ranges.length === 0) {
    return undefined;
  }

  const mutate = ranges.map(({ path, start, end }) => `${path}:${start}-${end}`);
  const paths = [...new Set(ranges.map(({ path }) => path))];

  return { mutate, ...testScope(paths) };
};
