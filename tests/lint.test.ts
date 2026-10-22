import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const root = fileURLToPath(new URL('../', import.meta.url));

it('rejects lint warnings in project checks', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-lint-');

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
  const directory = temporaryDirectory(onTestFinished, 'tau-style-');

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
  const directory = temporaryDirectory(onTestFinished, 'tau-style-size-');

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

it('keeps test helpers out of production code', async ({ onTestFinished }) => {
  // The directory must sit inside the repository, under `src/`.
  const directory = await mkdtemp(join(root, 'src', 'tau-lint-imports-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const helper = "import { initializeRepository } from '../../tests/gitRepository.js';\n";

  await writeFile(
    join(directory, 'probe.ts'),
    `${helper}\nexport const value = initializeRepository;\n`,
  );

  await writeFile(
    join(directory, 'probe.test.ts'),
    `${helper}\nexport const value = initializeRepository;\n`,
  );

  const result = spawnSync('pnpm', ['lint', '--format', 'agent', directory], {
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
  expect(diagnostics[0]).toContain('/probe.ts:');
}, 30_000);

const lintModuleBoundaries = (files: string[]) => {
  const result = spawnSync('pnpm', ['lint', '--format', 'agent', ...files], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const diagnostics = result.stdout
    .split('\n')
    .filter((line) => line.includes('tau(module-boundaries)'));

  return { result, diagnostics };
};

it('fails new shared files and shared imports that the module table does not list', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-modules-');
  await mkdir(join(directory, 'src'));

  const example = join(directory, 'src', 'example.ts');
  const valueImport = join(directory, 'src', 'skillTools.ts');
  const typeImport = join(directory, 'src', 'errors.ts');

  await writeFile(example, 'export const value = 1;\n');

  await writeFile(
    valueImport,
    "import { runGithub } from './github.js';\n\nexport const value = runGithub;\n",
  );

  await writeFile(
    typeImport,
    "import type { Problem } from './schema.js';\n\nexport type Value = Problem;\n",
  );

  const { result, diagnostics } = lintModuleBoundaries([example, valueImport, typeImport]);
  const linesFor = (file: string) => diagnostics.filter((line) => line.includes(file));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(3);
  expect(linesFor(example)[0]).toContain('File "example.ts" is not in a module');
  expect(linesFor(valueImport)[0]).toContain('"skillTools" must not import module "github"');
  expect(linesFor(typeImport)[0]).toContain('"errors" must not import module "schema"');
}, 30_000);

it('keeps extensions out of shared modules but lets the package entry load them', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-modules-');
  await mkdir(join(directory, 'src'));

  const shared = join(directory, 'src', 'skillTools.ts');
  const entry = join(directory, 'src', 'tau.ts');

  const extension =
    "import commit from './extensions/commit/commit.js';\n\nexport default commit;\n";

  await writeFile(shared, extension);
  await writeFile(entry, extension);

  const { result, diagnostics } = lintModuleBoundaries([shared, entry]);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain(shared);
}, 30_000);

it('keeps private controller files out of the rest of the subagents extension', async ({
  onTestFinished,
}) => {
  // The directory must sit inside the repository, under `src/`.
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

it('ignores an unrelated src folder above the project root', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-modules-');

  const project = join(directory, 'src', 'project');
  const files = ['scripts', 'lint', 'tests'].map((folder) => join(project, folder, 'probe.ts'));

  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{}\n');

  for (const file of files) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'export const value = 1;\n');
  }

  const { result, diagnostics } = lintModuleBoundaries(files);

  expect(result.error).toBeUndefined();
  expect(diagnostics).toEqual([]);
}, 30_000);
