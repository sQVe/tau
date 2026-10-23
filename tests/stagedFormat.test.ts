import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestContext } from 'vitest';
import { expect, it } from 'vitest';

import viteConfig from '../vite.config.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const jsonFamily = '!(pnpm-lock).{json,md,yaml,yml,css}';
const typeScriptFamily = '*.{ts,tsx,js,jsx,mjs,cjs}';

const stagedFormatterCommand = (pattern: string): string => {
  const staged = (viteConfig as { staged?: Record<string, string | string[]> }).staged;
  const configured = staged?.[pattern];
  const commands = Array.isArray(configured) ? configured : [configured];
  const formatter = commands.find((command) => command?.includes('fmt') === true);

  if (formatter == null) {
    throw new Error(`No staged formatter command configured for ${pattern}.`);
  }

  return formatter;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// Run the configured formatter exactly like the hook does: the command string with the matched
// staged paths appended.
const runStagedFormatter = (pattern: string, paths: string[]): number => {
  const command = stagedFormatterCommand(pattern);
  const appended = paths.map(shellQuote).join(' ');

  const result = spawnSync(`${command} ${appended}`, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();

  return result.status ?? 1;
};

// Files under `.pi/**` are excluded by `fmt.ignorePatterns`, the condition that makes staged
// formatter commands see no target file.
const createIgnoredFixture = async (name: string, contents: string) => {
  await mkdir(join(root, '.pi'), { recursive: true });
  // The directory must sit inside the repository so the formatter ignores it.
  const directory = await mkdtemp(join(root, '.pi', 'format-probe-'));
  const path = join(directory, name);
  await writeFile(path, contents);

  return { directory, path };
};

const createTemporaryFixture = async (
  cleanup: TestContext['onTestFinished'],
  name: string,
  contents: string,
) => {
  const directory = temporaryDirectory(cleanup, 'tau-staged-format-');
  const path = join(directory, name);
  await writeFile(path, contents);

  return { directory, path };
};

it.for([
  { family: jsonFamily, fileName: 'ignored.json', contents: '{"alpha":   1}\n' },
  { family: typeScriptFamily, fileName: 'ignored.ts', contents: 'const alpha   = 1\n' },
])(
  'accepts staged paths that the formatter ignores for $family',
  async ({ family, fileName, contents }, { onTestFinished }) => {
    const ignored = await createIgnoredFixture(fileName, contents);

    onTestFinished(() => rm(ignored.directory, { recursive: true, force: true }));

    expect(runStagedFormatter(family, [ignored.path])).toBe(0);
  },
);

it('rejects a supported unformatted staged file even when another target is ignored', async ({
  onTestFinished,
}) => {
  const ignored = await createIgnoredFixture('ignored.json', '{"alpha":   1}\n');

  const unformatted = await createTemporaryFixture(
    onTestFinished,
    'unformatted.json',
    '{"alpha":   1}\n',
  );

  onTestFinished(async () => {
    await rm(ignored.directory, { recursive: true, force: true });
  });

  expect(runStagedFormatter(jsonFamily, [ignored.path, unformatted.path])).toBe(1);
});

it('accepts a supported formatted staged file', async ({ onTestFinished }) => {
  const formatted = await createTemporaryFixture(
    onTestFinished,
    'formatted.json',
    '{\n  "alpha": 1\n}\n',
  );

  expect(runStagedFormatter(jsonFamily, [formatted.path])).toBe(0);
});
