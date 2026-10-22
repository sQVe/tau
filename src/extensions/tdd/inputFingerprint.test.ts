import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { installedPiPath } from '../../../scripts/piVersionDrift.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { defaultTddConfig } from './config.js';
import type { TddConfig } from './config.js';
import { fingerprintInputs, listInputs } from './inputFingerprint.js';

interface ParityResult {
  include: string;
  excludedGlobs: string[];
  failure: string | null;
  globbed: string[];
  walked: string[];
}

interface Difference {
  reason: string;
  allows: (entry: ParityResult, path: string) => boolean;
}

// The installed Pi is a Bun executable, and `BUN_BE_BUN` makes it run a script as Bun. CI has
// only the dependency's Node `pi`, so this check runs where Pi is installed.
const piEnvironment = {
  ...process.env,
  PATH: installedPiPath(process.env.PATH ?? '', delimiter),
  BUN_BE_BUN: '1',
};

const canRunInstalledPi =
  spawnSync('pi', ['--version'], { env: piEnvironment, timeout: 5000, stdio: 'ignore' }).status ===
  0;

const runUnderPi = (script: string, cwd: string) =>
  spawnSync('pi', [script, cwd], { env: piEnvironment, encoding: 'utf8', timeout: 30_000 });

it.runIf(canRunInstalledPi)(
  'fingerprints inputs under the Bun runtime of the installed Pi',
  async ({ onTestFinished }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');

    await mkdir(join(cwd, 'src/nested'), { recursive: true });
    await writeFile(join(cwd, 'src/value.ts'), 'value');
    await writeFile(join(cwd, 'value.test.ts'), 'test');

    const module = fileURLToPath(new URL('inputFingerprint.ts', import.meta.url));
    const configModule = fileURLToPath(new URL('config.ts', import.meta.url));
    const script = join(cwd, 'fingerprint.mts');

    await writeFile(
      script,
      [
        `import { fingerprintInputs } from ${JSON.stringify(module)};`,
        `import { defaultTddConfig } from ${JSON.stringify(configModule)};`,
        `const config = { ...defaultTddConfig, productionGlobs: ['src/**'] };`,
        `const fingerprint = await fingerprintInputs(process.argv[2], config, ['value.test.ts']);`,
        `console.log(JSON.stringify({ runtime: typeof Bun, fingerprint }));`,
      ].join('\n'),
    );

    const config = { ...defaultTddConfig, productionGlobs: ['src/**'] };
    const expected = await fingerprintInputs(cwd, config, ['value.test.ts']);
    const result = runUnderPi(script, cwd);

    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ runtime: 'object', fingerprint: expected });
    expect(expected).not.toBeNull();
  },
);

const writeFiles = async (cwd: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
};

const fingerprintAfter = async (cwd: string, change: () => Promise<void>) => {
  const before = await fingerprintInputs(cwd, defaultTddConfig, []);
  await change();

  return { before, after: await fingerprintInputs(cwd, defaultTddConfig, []) };
};

it('ignores a file under a dot directory', async ({ onTestFinished }) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'src/value.ts': 'value', '.hidden/value.test.ts': 'one' });

  const { before, after } = await fingerprintAfter(cwd, () =>
    writeFiles(cwd, { '.hidden/value.test.ts': 'two', 'src/.dot.ts': 'dot' }),
  );

  expect(after).toBe(before);
});

it('fingerprints an explicit dot path from the configuration globs', async ({ onTestFinished }) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { '.pi/tau.json': 'one' });

  const { before, after } = await fingerprintAfter(cwd, () =>
    writeFiles(cwd, { '.pi/tau.json': 'two' }),
  );

  expect(after).not.toBe(before);
});

it('ignores a file under an excluded directory', async ({ onTestFinished }) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'src/value.ts': 'value', 'node_modules/pkg/value.test.ts': 'one' });

  const { before, after } = await fingerprintAfter(cwd, () =>
    writeFiles(cwd, { 'node_modules/pkg/value.test.ts': 'two', 'src/generated/value.ts': 'new' }),
  );

  expect(after).toBe(before);
});

it('changes when an input changes, appears, or is deleted', async ({ onTestFinished }) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'src/value.ts': 'one' });

  const changed = await fingerprintAfter(cwd, () => writeFiles(cwd, { 'src/value.ts': 'two' }));
  const added = await fingerprintAfter(cwd, () => writeFiles(cwd, { 'src/other.ts': 'new' }));
  const deleted = await fingerprintAfter(cwd, () => rm(join(cwd, 'src/other.ts')));

  expect(changed.after).not.toBe(changed.before);
  expect(added.after).not.toBe(added.before);
  expect(deleted.after).not.toBe(deleted.before);
});

const onlyProduction = (...productionGlobs: string[]) => ({
  ...defaultTddConfig,
  productionGlobs,
  testGlobs: [],
  testSupportGlobs: [],
  excludedGlobs: [],
});

const rewriteChangesFingerprint = async (
  cwd: string,
  config: TddConfig,
  path: string,
): Promise<boolean> => {
  const before = await fingerprintInputs(cwd, config, []);

  await writeFile(join(cwd, path), 'rewritten');

  return before !== (await fingerprintInputs(cwd, config, []));
};

it('matches a dot segment only against a pattern segment that starts with a dot', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');

  await writeFiles(cwd, {
    '.config/a.ts': 'one',
    'src/.env.local': 'one',
    'src/.test.ts': 'one',
    'foo.hidden/.hidden/a.ts': 'one',
  });

  const braces = onlyProduction('{src,.config}/**');
  const wildcard = onlyProduction('**/.env*');
  const plain = onlyProduction('**/*.test.ts');
  const hiddenDirectory = onlyProduction('**/foo.hidden/**/*.ts');

  expect(await rewriteChangesFingerprint(cwd, braces, '.config/a.ts')).toBe(true);
  expect(await rewriteChangesFingerprint(cwd, wildcard, 'src/.env.local')).toBe(true);
  expect(await rewriteChangesFingerprint(cwd, plain, 'src/.test.ts')).toBe(false);

  const hidden = await rewriteChangesFingerprint(cwd, hiddenDirectory, 'foo.hidden/.hidden/a.ts');

  expect(hidden).toBe(false);
});

it('prunes an excluded directory by its own path and no other', async ({ onTestFinished }) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'src/a.ts': 'one' });

  const unrelatedExclude = { ...onlyProduction('src/**/*.ts'), excludedGlobs: ['**/x'] };
  const directoryExclude = { ...onlyProduction('src/**/*.ts'), excludedGlobs: ['src'] };

  expect(await rewriteChangesFingerprint(cwd, unrelatedExclude, 'src/a.ts')).toBe(true);
  expect(await rewriteChangesFingerprint(cwd, directoryExclude, 'src/a.ts')).toBe(false);
});

it('skips an unreadable directory and fingerprints the other inputs', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'src/a.ts': 'one', 'denied/b.ts': 'one' });
  await chmod(join(cwd, 'denied'), 0);
  onTestFinished(() => chmod(join(cwd, 'denied'), 0o755));

  const config = onlyProduction('**/*.ts');
  expect(await rewriteChangesFingerprint(cwd, config, 'src/a.ts')).toBe(true);
});

it('hashes a file under a symlinked directory reached through a wildcard', async ({
  onTestFinished,
}) => {
  const base = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  const cwd = join(base, 'repo');
  await writeFiles(cwd, { 'src/a.ts': 'one' });
  await writeFiles(base, { 'outside/value.ts': 'one' });
  await symlink('../../outside', join(cwd, 'src/shared'));
  await symlink('../outside', join(cwd, 'alias'));

  const deep = onlyProduction('**/*.ts');
  const shallow = onlyProduction('*/*.ts');

  expect(await rewriteChangesFingerprint(cwd, deep, '../outside/value.ts')).toBe(true);

  await writeFiles(base, { 'outside/value.ts': 'one' });

  expect(await rewriteChangesFingerprint(cwd, shallow, '../outside/value.ts')).toBe(true);
});

it('finishes when symlinked directories form a loop', async ({ onTestFinished }) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'a/x.ts': 'one' });
  await symlink('..', join(cwd, 'a/up'));
  await symlink('../b', join(cwd, 'a/b'));
  await symlink('../a', join(cwd, 'b'));

  expect(await rewriteChangesFingerprint(cwd, onlyProduction('**/*.ts'), 'a/x.ts')).toBe(true);
});

it('does not enter an excluded symlinked directory', async ({ onTestFinished }) => {
  const base = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  const cwd = join(base, 'repo');
  await writeFiles(cwd, { 'src/a.ts': 'one' });
  await writeFiles(base, { 'outside/value.ts': 'one' });
  await symlink('../../outside', join(cwd, 'src/shared'));

  const config = { ...onlyProduction('**/*.ts'), excludedGlobs: ['**/shared/**'] };

  expect(await rewriteChangesFingerprint(cwd, config, '../outside/value.ts')).toBe(false);
});

it('lists inputs for patterns with a leading ./ and for numeric brace ranges', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'src/a.ts': 'one', 'lib/b.ts': 'one', 'f2.ts': 'one', 'f4.ts': 'one' });

  const current = await rewriteChangesFingerprint(cwd, onlyProduction('./src/**/*.ts'), 'src/a.ts');
  const braced = await rewriteChangesFingerprint(cwd, onlyProduction('{./lib,x}/*.ts'), 'lib/b.ts');
  const inRange = await rewriteChangesFingerprint(cwd, onlyProduction('f{1..3}.ts'), 'f2.ts');
  const outOfRange = await rewriteChangesFingerprint(cwd, onlyProduction('f{1..3}.ts'), 'f4.ts');

  expect([current, braced, inRange, outOfRange]).toEqual([true, true, true, false]);
});

const parityFiles = {
  'src/a.ts': 'a',
  'src/a.test.ts': 'a',
  'src/nested/deep/b.ts': 'b',
  'src/nested/deep/b.test.ts': 'b',
  'src/.dot.ts': 'dot',
  'src/.hidden/c.ts': 'c',
  '.hidden/value.ts': 'value',
  '.hidden/.d.ts': 'd',
  'node_modules/pkg/e.ts': 'e',
  'node_modules/pkg/e.test.ts': 'e',
  '.pi/tau.json': '{}',
  'package.json': '{}',
  'f1.ts': 'f',
  'f2.ts': 'f',
  'f4.ts': 'f',
  'lib/real.ts': 'real',
  'other/g.ts': 'g',
  'loop/h.ts': 'h',
};

const parityIncludes = [
  '**/*.ts',
  '**/*',
  'src/**',
  './src/**/*.ts',
  '{src,lib}/**/*.ts',
  'f{1..3}.ts',
  'src/?.ts',
  '.hidden/**/*.ts',
  'src/.hidden/**',
  '**/.*',
  '**/*.test.ts',
  'src/nested/**/b.ts',
];

const parityExcludes = [
  defaultTddConfig.excludedGlobs,
  [],
  ['**/*.ts'],
  ['**/.hidden/**'],
  ['src/shared/**'],
  ['**/nested/**', './f1.ts'],
];

const parityConfigs = parityIncludes.flatMap((include) =>
  parityExcludes.map((excludedGlobs) => ({ include, excludedGlobs })),
);

// Runs under Pi's Bun, which lists inputs the old way (`glob`) and the new way (the walk).
const parityScript = (module: string, configModule: string) =>
  [
    `import { writeFileSync } from 'node:fs';`,
    `import { glob } from 'node:fs/promises';`,
    `import { listInputs } from ${JSON.stringify(module)};`,
    `import { configurationGlobs, defaultTddConfig } from ${JSON.stringify(configModule)};`,
    `const cwd = process.argv[2];`,
    `const results = [];`,
    `for (const { include, excludedGlobs } of ${JSON.stringify(parityConfigs)}) {`,
    `  const config = { ...defaultTddConfig, productionGlobs: [include], testGlobs: [], testSupportGlobs: [], excludedGlobs };`,
    `  const globbed = [];`,
    `  let failure = null;`,
    `  try {`,
    `    for await (const file of glob([include, ...configurationGlobs], { cwd, exclude: excludedGlobs })) globbed.push(file);`,
    `  } catch (error) {`,
    `    failure = error.code;`,
    `  }`,
    `  results.push({ include, excludedGlobs, failure, globbed: failure === null ? globbed.sort() : [], walked: (await listInputs(cwd, config)).sort() });`,
    `}`,
    `writeFileSync(process.argv[3], JSON.stringify(results));`,
  ].join('\n');

const isFile = async (cwd: string, path: string) =>
  (await stat(join(cwd, path)).catch(() => null))?.isFile() === true;

// `glob` lists a path with a leading ./ when its pattern has one; the walk never does.
const withoutCurrentDirectory = (path: string) => path.replace(/^(?:\.\/)+/u, '');

const hasDotDirectory = (path: string) =>
  path
    .split('/')
    .slice(0, -1)
    .some((segment) => segment.startsWith('.'));

const hasRangeBrace = (glob: string) => /\{-?\d+\.\.-?\d+\}/u.test(glob);

const excludedWithCurrentDirectory = (entry: ParityResult, path: string) =>
  entry.excludedGlobs.includes(`./${path}`);

// The only ways the lists may differ. Any other difference fails the test.
const walkOnlyDifferences: Difference[] = [
  {
    reason: '.pi/tau.json is hashed because a configuration glob names it',
    allows: (_entry, path) => path === '.pi/tau.json',
  },
  {
    reason: 'Bun glob never enters a dot directory; the walk does when a pattern names it',
    allows: (_entry, path) => hasDotDirectory(path),
  },
  {
    reason: 'Bun glob does not match a dot file through a wildcard such as **/.*',
    allows: (entry, path) =>
      entry.include.includes('/.*') && path.split('/').at(-1)?.startsWith('.') === true,
  },
  {
    reason: 'Bun glob does not expand a numeric range such as {1..3}; the walk does',
    allows: (entry) => hasRangeBrace(entry.include),
  },
];

const globOnlyDifferences: Difference[] = [
  {
    reason: 'Bun glob ignores a leading ./ in an exclude pattern; the walk honors it',
    allows: excludedWithCurrentDirectory,
  },
  {
    reason: 'Bun glob tests an exclude against the ./ path of a ./ include, so it can miss',
    allows: (entry) => entry.include.startsWith('./') && entry.excludedGlobs.length > 0,
  },
  {
    reason: 'Bun glob repeats files behind a link that points back to an ancestor; the walk stops',
    allows: (_entry, path) => path.startsWith('loop/back/'),
  },
];

const isAllowed = (differences: Difference[], entry: ParityResult, path: string) =>
  differences.some((difference) => difference.allows(entry, path));

const parityProblems = async (cwd: string, entry: ParityResult) => {
  const label = JSON.stringify({ include: entry.include, excludedGlobs: entry.excludedGlobs });

  // Bun glob can throw ELOOP on a link loop; the walk finishes, so the listing still ran.
  if (entry.failure === 'ELOOP') {
    return [];
  }

  if (entry.failure !== null) {
    return [`${label}: glob failed with ${entry.failure}`];
  }

  const names = entry.globbed.map(withoutCurrentDirectory);

  const checks = await Promise.all(
    names.map(async (path) => [path, await isFile(cwd, path)] as const),
  );

  const globbedFiles = checks.filter(([, ok]) => ok).map(([path]) => path);
  const globOnly = globbedFiles.filter((file) => !entry.walked.includes(file));
  const walkOnly = entry.walked.filter((file) => !globbedFiles.includes(file));

  return [
    ...globOnly
      .filter((file) => !isAllowed(globOnlyDifferences, entry, file))
      .map((file) => `${label}: glob only: ${file}`),
    ...walkOnly
      .filter((file) => !isAllowed(walkOnlyDifferences, entry, file))
      .map((file) => `${label}: walk only: ${file}`),
  ];
};

it.runIf(canRunInstalledPi)(
  'lists the same inputs as glob under the Bun runtime of the installed Pi',
  async ({ onTestFinished }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
    await writeFiles(cwd, parityFiles);
    await symlink('../lib', join(cwd, 'src/shared'));
    await symlink('a.ts', join(cwd, 'src/alias.ts'));
    await symlink('..', join(cwd, 'loop/back'));

    const module = fileURLToPath(new URL('inputFingerprint.ts', import.meta.url));
    const configModule = fileURLToPath(new URL('config.ts', import.meta.url));
    const script = join(cwd, '..', `${basename(cwd)}-parity.mts`);
    await writeFile(script, parityScript(module, configModule));
    onTestFinished(() => rm(script, { force: true }));

    const output = join(cwd, '..', `${basename(cwd)}-parity.json`);
    onTestFinished(() => rm(output, { force: true }));

    const result = spawnSync('pi', [script, cwd, output], {
      env: piEnvironment,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.stderr).toBe('');

    const results = JSON.parse(await readFile(output, 'utf8')) as ParityResult[];
    const problems = (await Promise.all(results.map((entry) => parityProblems(cwd, entry)))).flat();

    expect(problems).toEqual([]);

    expect(results.filter((entry) => entry.failure === null).length).toBeGreaterThan(
      parityConfigs.length / 2,
    );
  },
);

it('lists a symlink to a file as an input and walks a symlink loop once', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'top.ts': 'one', 'a/x.ts': 'one', 'a/real.ts': 'one' });
  await symlink('real.ts', join(cwd, 'a/link.ts'));
  await symlink('..', join(cwd, 'a/up'));
  await symlink('../b', join(cwd, 'a/b'));
  await symlink('a', join(cwd, 'b'));

  const inputs = await listInputs(cwd, onlyProduction('**/*.ts'));

  expect(inputs.toSorted()).toEqual([
    'a/link.ts',
    'a/real.ts',
    'a/x.ts',
    'b/link.ts',
    'b/real.ts',
    'b/x.ts',
    'top.ts',
  ]);
});

it('does not enter an excluded directory, even when it is a symlink to a directory elsewhere', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'src/a.ts': 'one', 'skipped/b.ts': 'one', 'other/c.ts': 'one' });
  await symlink('../other', join(cwd, 'skipped/link'));

  const config = { ...onlyProduction('**/*.ts'), excludedGlobs: ['skipped'] };

  expect((await listInputs(cwd, config)).toSorted()).toEqual(['other/c.ts', 'src/a.ts']);
});

it('hashes without failing when a listed test file is missing or is a directory', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await writeFiles(cwd, { 'src/a.ts': 'one' });
  await mkdir(join(cwd, 'dir.test.ts'));

  const config = onlyProduction('src/**');
  const base = await fingerprintInputs(cwd, config, []);

  expect(await fingerprintInputs(cwd, config, ['missing.test.ts'])).not.toBe(base);
  expect(await fingerprintInputs(cwd, config, ['dir.test.ts'])).toBe(base);
});

it('fails to hash a test file that cannot be read for another reason', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-');
  await symlink('loop.test.ts', join(cwd, 'loop.test.ts'));

  await expect(fingerprintInputs(cwd, onlyProduction(), ['loop.test.ts'])).rejects.toThrow('ELOOP');
});
