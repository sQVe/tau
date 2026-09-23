import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import viteConfig from '../vite.config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const jsonFamily = '!(pnpm-lock).{json,md,yaml,yml,css}';
const typeScriptFamily = '*.{ts,tsx,js,jsx,mjs,cjs}';

const stagedFormatterCommand = (pattern: string): string => {
  const staged = (viteConfig as { staged?: Record<string, string | string[]> }).staged;
  const configured = staged?.[pattern];
  const commands = Array.isArray(configured) ? configured : [configured];
  const formatter = commands.find((command) => command?.includes('fmt'));

  if (!formatter) {
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
  const directory = await mkdtemp(join(root, '.pi', 'format-probe-'));
  const path = join(directory, name);
  await writeFile(path, contents);

  return { directory, path };
};

const createTemporaryFixture = async (name: string, contents: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-staged-format-'));
  const path = join(directory, name);
  await writeFile(path, contents);

  return { directory, path };
};

it('accepts staged paths that the formatter ignores', async ({ onTestFinished }) => {
  const ignoredJson = await createIgnoredFixture('ignored.json', '{"alpha":   1}\n');
  const ignoredScript = await createIgnoredFixture('ignored.ts', 'const alpha   = 1\n');
  onTestFinished(async () => {
    await rm(ignoredJson.directory, { recursive: true, force: true });
    await rm(ignoredScript.directory, { recursive: true, force: true });
  });

  expect(runStagedFormatter(jsonFamily, [ignoredJson.path])).toBe(0);
  expect(runStagedFormatter(typeScriptFamily, [ignoredScript.path])).toBe(0);
});

it('rejects a supported unformatted staged file even when another target is ignored', async ({
  onTestFinished,
}) => {
  const ignored = await createIgnoredFixture('ignored.json', '{"alpha":   1}\n');
  const unformatted = await createTemporaryFixture('unformatted.json', '{"alpha":   1}\n');
  onTestFinished(async () => {
    await rm(ignored.directory, { recursive: true, force: true });
    await rm(unformatted.directory, { recursive: true, force: true });
  });

  expect(runStagedFormatter(jsonFamily, [ignored.path, unformatted.path])).toBe(1);
});

it('accepts a supported formatted staged file', async ({ onTestFinished }) => {
  const formatted = await createTemporaryFixture('formatted.json', '{\n  "alpha": 1\n}\n');
  onTestFinished(() => rm(formatted.directory, { recursive: true, force: true }));

  expect(runStagedFormatter(jsonFamily, [formatted.path])).toBe(0);
});
