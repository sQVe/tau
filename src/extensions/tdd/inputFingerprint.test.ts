import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { installedPiPath } from '../../../scripts/piVersionDrift.js';
import { defaultTddConfig } from './config.js';
import type { TddConfig } from './config.js';
import { fingerprintInputs } from './inputFingerprint.js';

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
    const cwd = await mkdtemp(join(tmpdir(), 'tau-input-fingerprint-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));

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

const createWorktree = async (onTestFinished: (callback: () => Promise<void>) => void) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-input-fingerprint-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));

  return cwd;
};

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
  const cwd = await createWorktree(onTestFinished);
  await writeFiles(cwd, { 'src/value.ts': 'value', '.hidden/value.test.ts': 'one' });

  const { before, after } = await fingerprintAfter(cwd, () =>
    writeFiles(cwd, { '.hidden/value.test.ts': 'two', 'src/.dot.ts': 'dot' }),
  );

  expect(after).toBe(before);
});

it('fingerprints an explicit dot path from the configuration globs', async ({ onTestFinished }) => {
  const cwd = await createWorktree(onTestFinished);
  await writeFiles(cwd, { '.pi/tau.json': 'one' });

  const { before, after } = await fingerprintAfter(cwd, () =>
    writeFiles(cwd, { '.pi/tau.json': 'two' }),
  );

  expect(after).not.toBe(before);
});

it('ignores a file under an excluded directory', async ({ onTestFinished }) => {
  const cwd = await createWorktree(onTestFinished);
  await writeFiles(cwd, { 'src/value.ts': 'value', 'node_modules/pkg/value.test.ts': 'one' });

  const { before, after } = await fingerprintAfter(cwd, () =>
    writeFiles(cwd, { 'node_modules/pkg/value.test.ts': 'two', 'src/generated/value.ts': 'new' }),
  );

  expect(after).toBe(before);
});

it('changes when an input changes, appears, or is deleted', async ({ onTestFinished }) => {
  const cwd = await createWorktree(onTestFinished);
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
  const cwd = await createWorktree(onTestFinished);

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
  const cwd = await createWorktree(onTestFinished);
  await writeFiles(cwd, { 'src/a.ts': 'one' });

  const unrelatedExclude = { ...onlyProduction('src/**/*.ts'), excludedGlobs: ['**/x'] };
  const directoryExclude = { ...onlyProduction('src/**/*.ts'), excludedGlobs: ['src'] };

  expect(await rewriteChangesFingerprint(cwd, unrelatedExclude, 'src/a.ts')).toBe(true);
  expect(await rewriteChangesFingerprint(cwd, directoryExclude, 'src/a.ts')).toBe(false);
});

it('skips an unreadable directory and fingerprints the other inputs', async ({
  onTestFinished,
}) => {
  const cwd = await createWorktree(onTestFinished);
  await writeFiles(cwd, { 'src/a.ts': 'one', 'denied/b.ts': 'one' });
  await chmod(join(cwd, 'denied'), 0);
  onTestFinished(() => chmod(join(cwd, 'denied'), 0o755));

  const config = onlyProduction('**/*.ts');
  expect(await rewriteChangesFingerprint(cwd, config, 'src/a.ts')).toBe(true);
});

it('follows a symlinked directory named by a literal pattern but not through a wildcard', async ({
  onTestFinished,
}) => {
  const cwd = await createWorktree(onTestFinished);
  await writeFiles(cwd, { 'real/a.ts': 'one' });
  await symlink('real', join(cwd, 'alias'));

  const literal = onlyProduction('alias/**/*.ts');
  const wildcard = onlyProduction('al*/*.ts');

  expect(await rewriteChangesFingerprint(cwd, literal, 'real/a.ts')).toBe(true);
  expect(await rewriteChangesFingerprint(cwd, wildcard, 'real/a.ts')).toBe(false);
});

it('lists inputs for patterns with a leading ./ and for numeric brace ranges', async ({
  onTestFinished,
}) => {
  const cwd = await createWorktree(onTestFinished);
  await writeFiles(cwd, { 'src/a.ts': 'one', 'lib/b.ts': 'one', 'f2.ts': 'one', 'f4.ts': 'one' });

  const current = await rewriteChangesFingerprint(cwd, onlyProduction('./src/**/*.ts'), 'src/a.ts');
  const braced = await rewriteChangesFingerprint(cwd, onlyProduction('{./lib,x}/*.ts'), 'lib/b.ts');
  const inRange = await rewriteChangesFingerprint(cwd, onlyProduction('f{1..3}.ts'), 'f2.ts');
  const outOfRange = await rewriteChangesFingerprint(cwd, onlyProduction('f{1..3}.ts'), 'f4.ts');

  expect([current, braced, inRange, outOfRange]).toEqual([true, true, true, false]);
});

it('does not hash another pattern through a symlink that only a text pattern names', async ({
  onTestFinished,
}) => {
  const base = await createWorktree(onTestFinished);
  const cwd = join(base, 'repo');
  await writeFiles(cwd, { 'src/a.ts': 'one' });
  await writeFiles(base, { 'outside/a.ts': 'one', 'outside/a.txt': 'one' });
  await symlink('../outside', join(cwd, 'alias'));

  const config = onlyProduction('**/*.ts', 'alias/*.txt');
  const typescript = await rewriteChangesFingerprint(cwd, config, '../outside/a.ts');
  const text = await rewriteChangesFingerprint(cwd, config, '../outside/a.txt');

  expect([typescript, text]).toEqual([false, true]);
});
