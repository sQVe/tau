import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

it('rejects lint warnings in project checks', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-lint-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'warning.js');
  await writeFile(fixture, 'console.log("warning fixture");\n');

  const result = spawnSync('pnpm', ['lint', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.status).toBe(1);
  expect(result.stdout).toContain('warning eslint(no-console)');
}, 30_000);

it('has no lint errors or warnings', async () => {
  const result = await executeFile('pnpm', ['lint'], { cwd: root, maxBuffer: 1024 * 1024 });

  expect(result.stdout + result.stderr).not.toMatch(/\b(?:warning|error) [\w-]+\(/);
}, 30_000);
