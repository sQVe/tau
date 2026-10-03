import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

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

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('eslint(no-console)');
}, 30_000);

it('runs house style only in the style command and Tau rules in both', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-style-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'style.ts');

  await writeFile(
    fixture,
    [
      'export const cb = (): number => 1;',
      '',
      "export const missing = (error: { code?: string }): boolean => error.code === 'ENOENT';",
      '',
    ].join('\n'),
  );

  const ordinary = spawnSync('pnpm', ['lint', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const style = spawnSync('pnpm', ['style:check', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(ordinary.error).toBeUndefined();
  expect(ordinary.status).toBe(1);
  expect(ordinary.stdout).toContain('tau(no-enoent-literal)');
  expect(ordinary.stdout).not.toContain('seam(no-abbreviations)');
  expect(style.error).toBeUndefined();
  expect(style.status).toBe(1);
  expect(style.stdout).toContain('tau(no-enoent-literal)');
  expect(style.stdout).toContain('seam(no-abbreviations)');
}, 60_000);

it('keeps size thresholds advisory without weakening other lint checks', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-style-size-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'large.ts');

  await writeFile(
    fixture,
    [
      'export const sum = (first: number, second: number, third: number, fourth: number, fifth: number): number => first + second + third + fourth + fifth;',
      '',
      'export const longFunction = (values: number[]): void => {',
      ...Array.from({ length: 61 }, () => '  values.push(values.length);'),
      '};',
      '',
      ...Array.from({ length: 501 }, (_, index) => `export const value${index} = ${index};`),
    ].join('\n'),
  );

  const result = spawnSync('pnpm', ['style:check', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('max-lines');
  expect(result.stdout).not.toContain('max-params');
}, 30_000);

it('keeps test helpers out of production code and extensions out of shared modules', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(root, 'src', 'tau-lint-imports-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const helper = "import { initializeRepository } from '../../tests/gitRepository.js';\n";
  const extension = "import { bulkReadTool } from '../extensions/bulkRead/tool.js';\n";

  await writeFile(
    join(directory, 'probe.ts'),
    `${helper}${extension}\nexport const value = [initializeRepository, bulkReadTool];\n`,
  );

  await writeFile(
    join(directory, 'probe.test.ts'),
    `${helper}\nexport const value = initializeRepository;\n`,
  );

  const result = spawnSync('pnpm', ['lint', directory], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const diagnostics = result.stdout
    .split('\n')
    .filter((line) => line.includes('no-restricted-imports'));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics.every((line) => line.includes('/probe.ts:'))).toBe(true);
}, 30_000);

it('keeps extensions out of flat shared modules but lets the package entry load them', async ({
  onTestFinished,
}) => {
  const probe = join(root, 'src', `tauLintFlat${randomUUID().replaceAll('-', '')}.ts`);
  onTestFinished(() => rm(probe, { force: true }));

  await writeFile(
    probe,
    "import { bulkReadTool } from './extensions/bulkRead/tool.js';\n\nexport const value = bulkReadTool;\n",
  );

  const result = spawnSync('pnpm', ['lint', probe, join(root, 'src', 'tau.ts')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const diagnostics = result.stdout
    .split('\n')
    .filter((line) => line.includes('no-restricted-imports'));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain('tauLintFlat');
}, 30_000);

it('keeps private controller files out of the rest of the subagents extension', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(
    join(root, 'src', 'extensions', 'subagents', 'tau-lint-private-'),
  );

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  await writeFile(
    join(directory, 'probe.ts'),
    [
      "import { launchTiming } from '../controller/budget.js';",
      "import { WorkerController } from '../controller/controller.js';",
      "import { EvidenceUnavailableError } from '../controller/record.js';",
      "import { stopOwnedWorker } from '../controller/stop.js';",
      '',
      'export const value = [launchTiming, WorkerController, EvidenceUnavailableError, stopOwnedWorker];',
      '',
    ].join('\n'),
  );

  const result = spawnSync('pnpm', ['lint', directory], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const diagnostics = result.stdout
    .split('\n')
    .filter((line) => line.includes('no-restricted-imports'));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain("'../controller/stop.js'");
}, 30_000);
