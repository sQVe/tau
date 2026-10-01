import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

it('enforces house style only when explicitly enabled', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-style-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'style.ts');

  await writeFile(
    fixture,
    [
      'export const MAX_RETRIES = 3;',
      'export interface requestOptions { request_id: string }',
      'export const cb = () => 1;',
      'export const caller = () => helper();',
      'const helper = () => 1;',
      'export const normalize = (name: string) => {',
      '  const trimmed = name.trim(); // Keep with the declaration.',
      '  return trimmed;',
      '};',
      'export const width = 80, height = 24;',
      'export const read = (value: string) => {',
      '  let result: string;',
      '  if ((result = value)) { return result; }',
      "  return '';",
      '};',
    ].join('\n'),
  );

  const environment = { ...process.env, TAU_LINT_STYLE: '0' };

  const ordinary = spawnSync('pnpm', ['lint', fixture], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const style = spawnSync(process.execPath, ['scripts/runStyle.ts', fixture], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(ordinary.error).toBeUndefined();
  expect(ordinary.status).toBe(0);
  expect(style.error).toBeUndefined();
  expect(style.status).toBe(1);

  for (const rule of [
    'naming-convention',
    'id-denylist',
    'helper-before-use',
    'padding-line-between-statements',
    'one-var',
    'no-cond-assign',
  ]) {
    expect(ordinary.stdout).not.toContain(rule);
    expect(style.stdout).toContain(rule);
  }
}, 60_000);

it('fixes house spacing without changing comments or names', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-style-fix-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'spacing.ts');

  await writeFile(
    fixture,
    [
      'export const normalize = (name: string) => {',
      '  const trimmed = name.trim(); // Keep with the declaration.',
      '  // Keep with the guard.',
      '  if (!trimmed) {',
      "    return 'unknown';",
      '  }',
      '  return trimmed;',
      '};',
      'export const width = 80, height = 24;',
    ].join('\n'),
  );

  const result = spawnSync(process.execPath, ['scripts/runStyle.ts', '--fix', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toMatch(/\berror\b/);
  expect(result.status).toBe(0);

  expect(await readFile(fixture, 'utf8')).toBe(
    [
      'export const normalize = (name: string) => {',
      '  const trimmed = name.trim(); // Keep with the declaration.',
      '',
      '  // Keep with the guard.',
      '  if (!trimmed) {',
      "    return 'unknown';",
      '  }',
      '',
      '  return trimmed;',
      '};',
      '',
      'export const width = 80;',
      'export const height = 24;',
      '',
    ].join('\n'),
  );

  const fixed = await readFile(fixture, 'utf8');

  const repeated = spawnSync(process.execPath, ['scripts/runStyle.ts', '--fix', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(repeated.error).toBeUndefined();
  expect(repeated.status).toBe(0);
  expect(await readFile(fixture, 'utf8')).toBe(fixed);

  const manual = join(directory, 'manual.ts');

  await writeFile(
    manual,
    'export const MAX_RETRIES=3;\nexport const caller=()=>helper();\nconst helper=()=>1;\n',
  );

  const manualResult = spawnSync(process.execPath, ['scripts/runStyle.ts', '--fix', manual], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(manualResult.error).toBeUndefined();
  expect(manualResult.status).toBe(1);

  expect(await readFile(manual, 'utf8')).toBe(
    'export const MAX_RETRIES = 3;\nexport const caller = () => helper();\nconst helper = () => 1;\n',
  );
}, 60_000);

it('pads loop exits and multiline statements in a form the formatter keeps', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-style-multiline-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'multiline.ts');

  await writeFile(
    fixture,
    [
      'export const limit = 9;',
      'export const options = {',
      '  limit,',
      '};',
      '',
      'export const collect = (values: number[]) => {',
      '  const collected: number[] = [];',
      '',
      '  for (const value of values) {',
      '    if (value < 0) {',
      '      collected.push(0);',
      '      continue;',
      '    }',
      '',
      '    if (value > limit) {',
      '      collected.push(limit);',
      '      break;',
      '    }',
      '',
      '    collected.push(value);',
      '  }',
      '',
      '  collected.sort((left, right) => left - right);',
      '  Object.assign(collected, {',
      '    total: collected.length,',
      '  });',
      '  collected.reverse();',
      '',
      '  return collected;',
      '};',
      '',
    ].join('\n'),
  );

  const check = spawnSync(process.execPath, ['scripts/runStyle.ts', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const diagnostics = check.stdout
    .split('\n')
    .filter((line) => line.includes('padding-line-between-statements'));

  expect(check.error).toBeUndefined();
  expect(check.status).toBe(1);
  expect(diagnostics).toHaveLength(5);

  const fix = spawnSync(process.execPath, ['scripts/runStyle.ts', '--fix', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(fix.error).toBeUndefined();
  expect(fix.status).toBe(0);

  expect(await readFile(fixture, 'utf8')).toBe(
    [
      'export const limit = 9;',
      '',
      'export const options = {',
      '  limit,',
      '};',
      '',
      'export const collect = (values: number[]) => {',
      '  const collected: number[] = [];',
      '',
      '  for (const value of values) {',
      '    if (value < 0) {',
      '      collected.push(0);',
      '',
      '      continue;',
      '    }',
      '',
      '    if (value > limit) {',
      '      collected.push(limit);',
      '',
      '      break;',
      '    }',
      '',
      '    collected.push(value);',
      '  }',
      '',
      '  collected.sort((left, right) => left - right);',
      '',
      '  Object.assign(collected, {',
      '    total: collected.length,',
      '  });',
      '',
      '  collected.reverse();',
      '',
      '  return collected;',
      '};',
      '',
    ].join('\n'),
  );

  const recheck = spawnSync(process.execPath, ['scripts/runStyle.ts', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(recheck.error).toBeUndefined();
  expect(recheck.status).toBe(0);
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
      'export const sum = (first: number, second: number, third: number, fourth: number, fifth: number) => first + second + third + fourth + fifth;',
      '',
      'export const longFunction = (values: number[]) => {',
      ...Array.from({ length: 61 }, (_, index) => `  values.push(${index});`),
      '};',
      '',
      ...Array.from({ length: 501 }, (_, index) => `export const value${index} = ${index};`),
    ].join('\n'),
  );

  const result = spawnSync(process.execPath, ['scripts/runStyle.ts', fixture], {
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
