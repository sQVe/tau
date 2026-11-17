import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { expect, it } from 'vitest';

const repositoryRoot = resolvePath(import.meta.dirname, '..');

const probeDirectories = (prefix: string): string[] => {
  const prefixes = [`tau-${prefix}-target-`, `tau-${prefix}-agent-`, `tau-${prefix}-extra-`];

  return readdirSync(tmpdir()).filter((entry) =>
    prefixes.some((probePrefix) => entry.startsWith(probePrefix)),
  );
};

const removeProbeDirectories = (prefix: string): void => {
  for (const entry of probeDirectories(prefix)) {
    rmSync(join(tmpdir(), entry), { recursive: true, force: true });
  }
};

const runNested = (directory: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      join(repositoryRoot, 'node_modules', '.bin', 'vitest'),
      ['run', '--config', join(directory, 'vitest.config.mjs')],
      { cwd: directory, timeout: 25_000 },
      (error) => {
        resolve(error === null);
      },
    );
  });

const nestedSuiteSource = (prefix: string, outcome: 'pass' | 'fail'): string => {
  const lines = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { beforeAll, expect, it } from 'vitest';",
    `import { useSharedCargoEnvironment } from ${JSON.stringify(join(repositoryRoot, 'tests', 'nextestHarness.js'))};`,
    `import { suiteCleanup, temporaryDirectory } from ${JSON.stringify(join(repositoryRoot, 'tests', 'temporaryDirectoryHarness.js'))};`,
    '',
    `useSharedCargoEnvironment(${JSON.stringify(prefix)});`,
    '',
    'const registerCleanup = suiteCleanup();',
    "let extraDirectory = '';",
    '',
    'beforeAll(() => {',
    `  extraDirectory = temporaryDirectory(registerCleanup, ${JSON.stringify(`tau-${prefix}-extra-`)});`,
    "  writeFileSync(join(extraDirectory, 'ran.txt'), 'ran');",
    '});',
    '',
    'registerCleanup(() => {',
    "  const seen = existsSync(join(import.meta.dirname, 'async-cleanup.marker')) ? 'after' : 'early';",
    "  writeFileSync(join(import.meta.dirname, 'order.marker'), seen);",
    '});',
    '',
    'registerCleanup(async () => {',
    '  await new Promise((resolve) => setImmediate(resolve));',
    "  writeFileSync(join(import.meta.dirname, 'async-cleanup.marker'), 'ran');",
    '});',
    '',
    "it('creates the shared directories', () => {",
    '  const targetDirectory = process.env.CARGO_TARGET_DIR;',
    '  expect(targetDirectory).toBeDefined();',
    "  writeFileSync(join(targetDirectory as string, 'ran.txt'), 'ran');",
    "  writeFileSync(join(extraDirectory, 'ran.txt'), 'ran');",
    "  writeFileSync(join(import.meta.dirname, 'ran.marker'), 'ran');",
    '});',
  ];

  if (outcome === 'fail') {
    lines.push(
      '',
      "it('fails after the directories exist', () => {",
      '  expect(1).toBe(2);',
      '});',
    );
  }

  return lines.join('\n');
};

const runSuite = async (
  outcome: 'pass' | 'fail',
): Promise<{ directory: string; prefix: string; succeeded: boolean }> => {
  const prefix = `harness-leak-${randomUUID()}`;
  const directory = join(tmpdir(), `tau-${prefix}-nested-`);

  mkdirSync(directory, { recursive: true });
  symlinkSync(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');

  writeFileSync(
    join(directory, 'vitest.config.mjs'),
    `export default { root: ${JSON.stringify(directory)}, test: { include: ['*.test.ts'] } };\n`,
  );

  writeFileSync(
    join(directory, 'sharedCargoEnvironment.test.ts'),
    nestedSuiteSource(prefix, outcome),
  );

  return { directory, prefix, succeeded: await runNested(directory) };
};

const expectCleanSuite = async (
  onTestFinished: (cleanup: () => void) => void,
  outcome: 'pass' | 'fail',
): Promise<void> => {
  const { directory, prefix, succeeded } = await runSuite(outcome);

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
    removeProbeDirectories(prefix);
  });

  expect(existsSync(join(directory, 'ran.marker'))).toBe(true);
  expect(existsSync(join(directory, 'async-cleanup.marker'))).toBe(true);
  expect(readFileSync(join(directory, 'order.marker'), 'utf8')).toBe('after');
  expect(succeeded).toBe(outcome === 'pass');
  expect(probeDirectories(prefix)).toEqual([]);
};

it('removes the shared cargo directories when a failing suite exits', async ({
  onTestFinished,
}) => {
  await expectCleanSuite(onTestFinished, 'fail');
});

it('removes the shared cargo directories when a passing suite exits', async ({
  onTestFinished,
}) => {
  await expectCleanSuite(onTestFinished, 'pass');
});
