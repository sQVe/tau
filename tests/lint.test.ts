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
  const style = spawnSync('pnpm', ['style:check', fixture], {
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

it('checks binding names and helper order without rejecting external fields or recursion', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-style-bindings-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixtures = [
    [
      'valid.ts',
      `
      export interface RequestOptions { request_id: string }
      export type Result<Value> = Value | null;
      export class RequestError extends Error {}
      export const { request_id: requestId } = { request_id: 'one' };
      export const { omitted: _omitted, ...rest } = { omitted: 1, kept: 2 };
      export const unusedParameter = (_event: unknown, value: string) => value;
      export const anonymousParameter = (_: unknown, value: string) => value;
      export const recursive = (value: number): number => value ? recursive(value - 1) : 0;
      export type HelperResult = ReturnType<typeof helper>;
      const helper = () => 1;
      export const caller = () => helper();
      export const callback = () => laterValue;
      const laterValue = 1;
    `,
    ],
    [
      'invalid.ts',
      `
      export const MAX_RETRIES = 3;
      export interface requestOptions {}
      export type result<value> = value | null;
      export class requestError extends Error {}
      export const { request_id } = { request_id: 'one' };
      export const readParameter = (_value: string) => _value;
      export const badUnusedName = (_bad_name: unknown, value: string) => value;
      export const { omitted: _bad_name, ...rest } = { omitted: 1, kept: 2 };
      export const caller = () => helper();
      const helper = () => 1;
    `,
    ],
    [
      'shadowing.ts',
      `
      export const caller = () => helper();
      const helper = () => 1;
      export const other = (helper: () => number) => helper();
    `,
    ],
    [
      'wrapped.ts',
      `
      export const caller = () => helper();
      const helper = (() => 1) satisfies () => number;
      export const secondCaller = () => secondHelper();
      const secondHelper = function () { return 2; } as () => number;
      export const declarationCaller = () => declaredHelper();
      function declaredHelper() { return 3; }
    `,
    ],
    [
      'cycle.ts',
      `
      // eslint-disable-next-line tau/helper-before-use -- Mutually recursive helpers.
      export const even = (value: number): boolean => value === 0 || odd(value - 1);
      const odd = (value: number): boolean => value !== 0 && even(value - 1);
    `,
    ],
  ];

  for (const [name, source] of fixtures) {
    await writeFile(join(directory, name!), source!);
  }

  const result = spawnSync('pnpm', ['style:check', directory], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  const diagnostics = result.stdout.split('\n').filter((line) => line.includes('tau('));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics.filter((line) => line.includes('/valid.ts:'))).toEqual([]);
  expect(diagnostics.filter((line) => line.includes('/cycle.ts:'))).toEqual([]);
  expect(
    diagnostics.filter(
      (line) => line.includes('/wrapped.ts:') && line.includes('helper-before-use'),
    ),
  ).toHaveLength(3);
  expect(
    diagnostics.filter(
      (line) => line.includes('/invalid.ts:') && line.includes('naming-convention'),
    ),
  ).toHaveLength(9);
  expect(
    diagnostics.filter(
      (line) => line.includes('/invalid.ts:') && line.includes('helper-before-use'),
    ),
  ).toHaveLength(1);
  expect(
    diagnostics.filter(
      (line) => line.includes('/shadowing.ts:') && line.includes('helper-before-use'),
    ),
  ).toHaveLength(1);
}, 30_000);

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

  const result = spawnSync('pnpm', ['style:fix', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain('error');
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
      'export const width = 80;',
      'export const height = 24;',
      '',
    ].join('\n'),
  );

  const fixed = await readFile(fixture, 'utf8');
  const repeated = spawnSync('pnpm', ['style:fix', fixture], {
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

  const manualResult = spawnSync('pnpm', ['style:fix', manual], {
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
