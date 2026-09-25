import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  const result = spawnSync(process.execPath, ['scripts/runStyle.ts', directory], {
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
      'export const longFunction = (values: number[]) => {',
      ...Array.from({ length: 61 }, (_, index) => `  values.push(${index});`),
      '};',
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

it('limits the checks joined in one condition and rejects mixed operators', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-style-conditions-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixtures = [
    [
      'valid.ts',
      `
      export const three = (a: boolean, b: boolean, c: boolean) => a || b || c;
      export const fallback = (a?: string, b?: string, c?: string, d?: string) => a ?? b ?? c ?? d;
      export const negated = (a: boolean, b: boolean, c: boolean) => !(a || b || c);
      export const wrapped = (a: boolean, b: boolean, c: boolean) => (a || b || c) satisfies boolean;
      export const named = (a: boolean, b: boolean, c: boolean) => {
        const either = b || c;

        return a && either;
      };
    `,
    ],
    [
      'invalid.ts',
      `
      export const four = (a: boolean, b: boolean, c: boolean, d: boolean) => a || b || c || d;
      export const mixed = (a: boolean, b: boolean, c: boolean) => a && (b || c);
      export const asserted = (a: boolean, b: boolean, c: boolean) => a && ((b || c) as boolean);
      export const satisfied = (a: boolean, b: boolean, c: boolean) => a && ((b || c) satisfies boolean);
      export const negated = (a: boolean, b: boolean, c: boolean) => a && !(b || c);
    `,
    ],
  ];

  for (const [name, source] of fixtures) {
    await writeFile(join(directory, name!), source!);
  }

  const result = spawnSync(process.execPath, ['scripts/runStyle.ts', directory], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const diagnostics = result.stdout
    .split('\n')
    .filter((line) => line.includes('max-condition-checks'));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics.filter((line) => line.includes('/valid.ts:'))).toEqual([]);
  expect(diagnostics.filter((line) => line.includes('/invalid.ts:'))).toHaveLength(5);
}, 30_000);

it('rejects ENOENT literals outside the errors module and tests', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-style-enoent-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixtures = [
    ['valid.ts', "export const reasons = { ENOENT: 'missing' };\n"],
    [
      'fake.test.ts',
      "export const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });\n",
    ],
    [
      'invalid.ts',
      "export const missing = (error: { code?: string }) => error.code === 'ENOENT';\n",
    ],
  ];

  for (const [name, source] of fixtures) {
    await writeFile(join(directory, name!), source!);
  }

  const result = spawnSync(process.execPath, ['scripts/runStyle.ts', directory], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const diagnostics = result.stdout
    .split('\n')
    .filter((line) => line.includes('no-enoent-literal'));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain('/invalid.ts:');
}, 30_000);

it('rejects imports from one extension into another', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-style-boundary-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const extension = join(directory, 'src', 'extensions', 'probe');
  await mkdir(extension, { recursive: true });

  const files = {
    'own.ts': 'export const own = 1;\n',
    'valid.ts': "import { own } from './own.js';\n\nexport const value = own;\n",
    'invalid.ts':
      "import { errorMessage } from '../../errors/index.js';\nimport { bulkReadTool } from '../bulkRead/tool.js';\nimport tau from '../index.js';\n\nexport const value = [errorMessage, bulkReadTool, tau];\n",
  };

  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(extension, name), source);
  }

  const result = spawnSync(process.execPath, ['scripts/runStyle.ts', extension], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const diagnostics = result.stdout
    .split('\n')
    .filter((line) => line.includes('extension-boundary'));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics.every((line) => line.includes('/invalid.ts:'))).toBe(true);
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
