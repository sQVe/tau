import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTestObservation } from '../observation.js';
import { runContext, summarize } from '../render.js';
import { runTests } from './index.js';
import { defaultResolveVitest } from './resolution.js';
import type { SpawnFn } from './types.js';

let cwd: string;
let manifestPath: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'tau-resolution-'));
  manifestPath = join(cwd, 'node_modules/vitest/package.json');
  vi.stubEnv('PI_CODING_AGENT_DIR', join(cwd, 'agent'));
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });
});

const manifest = async (content: string) => {
  await mkdir(join(cwd, 'node_modules/vitest'), { recursive: true });
  await writeFile(manifestPath, content);
};

it('distinguishes an unavailable Vitest package from a resolver failure', async () => {
  const missing = defaultResolveVitest(cwd);

  expect(missing).toMatchObject({
    kind: 'runner-missing',
    resolution: {
      stage: 'lookup',
      cwd,
      request: 'vitest/package.json',
      errorCode: 'MODULE_NOT_FOUND',
    },
  });
  await manifest(
    JSON.stringify({ name: 'vitest', version: '5.0.1', exports: { '.': './index.js' } }),
  );
  const blocked = defaultResolveVitest(cwd);

  expect(blocked).toMatchObject({
    kind: 'runner-resolution-error',
    resolution: { stage: 'lookup', cwd, errorCode: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
  });
  expect(blocked).toHaveProperty('message', expect.stringContaining('exports'));
});

it('names the package root when requested files belong to another package, such as a nested worktree', async () => {
  await mkdir(join(cwd, 'other/src'), { recursive: true });
  await writeFile(join(cwd, 'other/package.json'), '{}');
  const run = (files: string[]) =>
    runTests(
      { scope: 'changed', cwd, files },
      { resolveVitest: defaultResolveVitest, spawn: vi.fn<SpawnFn>(), timeoutMs: 30_000 },
    );

  const elsewhere = await run(['other/src/value.test.ts']);
  const local = await run(['value.test.ts']);

  expect(elsewhere).toHaveProperty('message', expect.stringContaining(join(cwd, 'other')));
  expect(local).toHaveProperty('message', expect.not.stringContaining(join(cwd, 'other')));
});

it('does not call Vitest absent when its manifest export points to a missing file', async () => {
  await manifest(
    JSON.stringify({
      name: 'vitest',
      version: '5.0.1',
      exports: { './package.json': './missing.json' },
    }),
  );
  const result = defaultResolveVitest(cwd);

  expect(result).toMatchObject({
    kind: 'runner-resolution-error',
    resolution: { stage: 'lookup', errorCode: 'MODULE_NOT_FOUND' },
  });
  expect(result).toHaveProperty(
    'message',
    expect.stringContaining('does not establish that Vitest is absent'),
  );
});

it('reports malformed manifests without copying JSON parse excerpts or credentials', async () => {
  const secret = 'credential-that-must-not-appear';
  await manifest(`{"token":"${secret}", invalid JSON`);
  const result = defaultResolveVitest(cwd);

  expect(result).toMatchObject({ kind: 'runner-resolution-error' });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain('invalid JSON');
  expect(result).toHaveProperty('message', expect.stringContaining('manifest'));
});

it('distinguishes a missing bin declaration from a missing binary file', async () => {
  await manifest(
    JSON.stringify({ name: 'vitest', version: '5.0.1', token: 'private-manifest-value' }),
  );
  const missingEntry = defaultResolveVitest(cwd);

  expect(missingEntry).toMatchObject({
    kind: 'runner-resolution-error',
    resolution: { stage: 'binary', manifestPath, errorCode: 'INVALID_BIN' },
  });
  expect(JSON.stringify(missingEntry)).not.toContain('private-manifest-value');
  await manifest(JSON.stringify({ name: 'vitest', version: '5.0.1', bin: './missing.mjs' }));
  const missingFile = defaultResolveVitest(cwd);

  expect(missingFile).toMatchObject({
    kind: 'runner-resolution-error',
    resolution: {
      stage: 'binary',
      manifestPath,
      binaryPath: join(cwd, 'node_modules/vitest/missing.mjs'),
      errorCode: 'ENOENT',
    },
  });
});

it('rejects invalid manifest versions and unsafe bin entries without echoing their values', async () => {
  for (const fields of [
    { version: 'secret-version-value', bin: './vitest.mjs' },
    { version: '5.0.1', bin: 'https://user:secret-bin-value@example.invalid/runner' },
    { version: '5.0.1', bin: '../../secret-bin-value' },
  ]) {
    await manifest(JSON.stringify({ name: 'vitest', ...fields }));
    const result = defaultResolveVitest(cwd);

    expect(result).toMatchObject({ kind: 'runner-resolution-error' });
    expect(JSON.stringify(result)).not.toContain('secret-');
  }
});

it('does not classify a throwing resolver dependency error as an absent Vitest package', async () => {
  const result = await runTests(
    { scope: 'all', cwd },
    {
      resolveVitest: () => {
        throw Object.assign(new Error('private dependency'), { code: 'MODULE_NOT_FOUND' });
      },
      spawn: vi.fn<SpawnFn>(),
      timeoutMs: 30_000,
    },
  );

  expect(result).toMatchObject({
    kind: 'runner-resolution-error',
    resolution: { stage: 'resolver', errorCode: 'MODULE_NOT_FOUND' },
  });
  expect(result).toHaveProperty(
    'message',
    expect.stringContaining('does not establish that Vitest is absent'),
  );
  expect(JSON.stringify(result)).not.toContain('private dependency');
});

it('retains safe diagnostics when an injected resolver throws without starting execution', async () => {
  const spawn = vi.fn<SpawnFn>();
  const secret = 'https://user:credential@example.invalid/token';
  const error = Object.assign(new TypeError(`\u001b[31m${secret}\n${'x'.repeat(10_000)}`), {
    code: 'EACCES',
  });
  const result = await runTests(
    { scope: 'all', cwd },
    {
      resolveVitest: () => {
        throw error;
      },
      spawn,
      timeoutMs: 30_000,
    },
  );

  expect(result).toMatchObject({
    kind: 'runner-resolution-error',
    resolution: { stage: 'resolver', cwd, errorCode: 'EACCES', errorType: 'TypeError' },
    diagnostics: { started: false, exitCode: null, resolution: { errorCode: 'EACCES' } },
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain('\\u001b');
  expect(JSON.stringify(result).length).toBeLessThan(4000);
  expect(spawn).not.toHaveBeenCalled();
});

it('bounds and sanitizes resolution paths without copying error messages', async () => {
  const result = await runTests(
    { scope: 'all', cwd: `${cwd}/\u001b[31m\n${'x'.repeat(1000)}` },
    {
      resolveVitest: () => {
        throw new Error('private-message');
      },
      spawn: vi.fn<SpawnFn>(),
      timeoutMs: 30_000,
    },
  );

  expect(result).toHaveProperty('resolution.cwd', expect.stringContaining('[cut]'));
  expect(JSON.stringify(result)).not.toContain('private-message');
  expect(JSON.stringify(result)).not.toContain('\\u001b');
  expect(JSON.stringify(result)).not.toContain('\\nxxx');
  expect('message' in result && result.message.length).toBeLessThan(1000);
});

it('does not echo arbitrary resolver error names codes or thrown values', async () => {
  for (const error of [
    Object.assign(new Error('private-message'), {
      name: 'private-name',
      code: 'PRIVATE_CREDENTIAL',
    }),
    'private-thrown-value',
  ]) {
    const result = await runTests(
      { scope: 'all', cwd },
      {
        resolveVitest: () => {
          // oxlint-disable-next-line typescript/only-throw-error -- A resolver can throw a non-Error value; its text must stay private.
          throw error;
        },
        spawn: vi.fn<SpawnFn>(),
        timeoutMs: 30_000,
      },
    );

    expect(result).toMatchObject({
      kind: 'runner-resolution-error',
      diagnostics: { started: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|PRIVATE_CREDENTIAL/);
  }
});

it('persists and presents resolution evidence through the production observation flow', async () => {
  await manifest(
    JSON.stringify({ name: 'vitest', version: '5.0.1', credentials: 'secret-manifest-field' }),
  );
  await writeFile(join(cwd, 'value.test.ts'), 'test');
  const behavior = { behavior: 'value', files: ['value.test.ts'], testFullName: 'works' };
  const observed = await createTestObservation(cwd).run(behavior, 'focused');
  const record = await readFile(observed.runPath!, 'utf8');
  const saved: unknown = JSON.parse(record);
  const summary = summarize(cwd, observed);
  const context = runContext(behavior, observed);

  expect(observed).toMatchObject({ kind: 'runner-resolution-error', freshness: 'fresh' });
  expect(saved).toMatchObject({
    kind: 'runner-resolution-error',
    diagnostics: {
      started: false,
      resolution: { cwd, manifestPath, stage: 'binary', errorCode: 'INVALID_BIN' },
    },
  });
  expect(record).not.toContain('secret-manifest-field');
  expect(summary).toContain('Inspect this once');
  expect(summary).toContain('repository runner');
  expect(summary).toContain('Bash tests do not update Tau observations');
  expect(summary).toContain(manifestPath);
  expect(summary).not.toContain('secret-manifest-field');
  expect(context).toContain('Execution did not start');
  expect(context).toContain(observed.runPath);
  expect(context).not.toContain('Elapsed:');
  expect(summary.length).toBeLessThanOrEqual(2000);
});
