import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { createHarness, createWorktree } from './tddHarness.js';

vi.setConfig({ testTimeout: 125_000 });

it.for(['tui', 'rpc'] as const)(
  'notifies once for an edit hint through Pi in %s mode without changing tool results',
  async (mode, { onTestFinished }) => {
    const { cwd, session, call } = await createHarness(onTestFinished);
    const notify = vi.fn<ExtensionUIContext['notify']>();
    await session.bindExtensions({
      mode,
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
    const failed = await call('edit', {
      path: 'src/value.ts',
      edits: [{ oldText: 'missing', newText: '2' }],
    });

    expect(failed.isError).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    const edited = await call('edit', {
      path: 'src/value.ts',
      edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
    });
    const hint =
      'Hint: No RED observed for this behavior; start the next behavior with a failing focused test.';

    expect(edited.isError).toBe(false);
    expect(edited.result).toHaveProperty('details.diff', expect.stringContaining('value = 2'));
    expect(JSON.stringify(edited.result)).toContain(hint);
    expect(notify).toHaveBeenCalledExactlyOnceWith(hint, 'info');
    const written = await call('write', {
      path: 'src/value.ts',
      content: 'export const value = 3;',
    });

    expect(written.isError).toBe(false);
    expect(JSON.stringify(written.result)).not.toContain('Hint:');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await readFile(join(cwd, 'src/value.ts'), 'utf8')).toBe('export const value = 3;');
  },
);

it('allows production edits with one advisory hint and no persisted permission state', async ({
  onTestFinished,
}) => {
  const { cwd, call } = await createHarness(onTestFinished);
  const input = { path: 'src/value.ts', content: 'export const value = 1;' };
  const written = await call('write', input);

  expect(written.isError).toBe(false);
  expect(JSON.stringify(written.result)).toContain('Hint:');
  expect(JSON.stringify(written.result)).toContain('RED');
  expect(await readFile(join(cwd, input.path), 'utf8')).toBe(input.content);

  const repeated = await call('write', { ...input, content: 'export const value = 2;' });

  expect(repeated.isError).toBe(false);
  expect(JSON.stringify(repeated.result)).not.toContain('Hint:');
  await expect(readFile(join(cwd, '.tau/state.json'))).rejects.toThrow(/ENOENT/);
});

it('keeps generated output quiet and hints stale after a layout edit through Pi', async ({
  onTestFinished,
}) => {
  const { cwd, run, call } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required behavior', () => {});",
  );
  const verified = await run({ scope: 'full' });

  expect(verified.details).toMatchObject({ kind: 'pass', freshness: 'fresh' });
  const generated = await call('write', {
    path: 'apps/web/dist/page.ts',
    content: 'generated output',
  });

  expect(generated.isError).toBe(false);
  expect(JSON.stringify(generated.result)).not.toContain('Hint:');
  const afterGenerated = await run({ scope: 'full' });

  expect(afterGenerated.details.inputs).toEqual(verified.details.inputs);
  const edited = await call('write', {
    path: 'apps/web/src/page.ts',
    content: 'export const page = 1;',
  });

  expect(edited.isError).toBe(false);
  expect(JSON.stringify(edited.result)).toContain('stale');
  expect(await readFile(join(cwd, 'apps/web/src/page.ts'), 'utf8')).toBe('export const page = 1;');
});

it('counts a full pass without RED and resets observations in another Pi session', async ({
  onTestFinished,
}) => {
  const first = await createHarness(onTestFinished);

  await writeFile(
    join(first.cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required behavior', () => {});",
  );
  expect(await first.run({ scope: 'full' })).toMatchObject({
    details: { kind: 'pass', freshness: 'fresh' },
  });

  const second = await createHarness(onTestFinished, [], first.cwd);
  const result = await second.call('write', {
    path: 'src/value.ts',
    content: 'export const value = 1;',
  });

  expect(result.isError).toBe(false);
  expect(JSON.stringify(result.result)).toContain('RED');
  expect(JSON.stringify(result.result)).not.toContain('stale');
});

it('preserves edit details and errors and ignores old malformed evidence through Pi', async ({
  onTestFinished,
}) => {
  const { cwd, call } = await createHarness(onTestFinished);

  await mkdir(join(cwd, '.tau'));
  await writeFile(join(cwd, '.tau/state.json'), 'corrupt');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  const failed = await call('edit', {
    path: 'src/value.ts',
    edits: [{ oldText: 'missing', newText: '2' }],
  });

  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed.result)).not.toContain('Hint:');

  const edited = await call('edit', {
    path: 'src/value.ts',
    edits: [{ oldText: '= 1', newText: '= 2' }],
  });

  expect(edited.isError).toBe(false);
  expect(edited.result).toHaveProperty('details.diff');
  expect(JSON.stringify(edited.result)).toContain('Hint:');
  expect(await readFile(join(cwd, '.tau/state.json'), 'utf8')).toBe('corrupt');
  expect(
    (await call('write', { path: 'package.json', content: '{"type":"module"}' })).isError,
  ).toBe(false);
});

it('appends production hints through a symlinked Pi cwd', async ({ onTestFinished }) => {
  const cwd = await createWorktree(onTestFinished);
  const alias = `${cwd}-hint-alias`;

  await symlink(cwd, alias, 'dir');
  onTestFinished(() => rm(alias, { force: true }));
  const { call } = await createHarness(onTestFinished, [], alias);
  const written = await call('write', { path: 'src/value.ts', content: 'export const value = 1;' });

  expect(written.isError).toBe(false);
  expect(JSON.stringify(written.result)).toContain('RED');
  expect(await readFile(join(cwd, 'src/value.ts'), 'utf8')).toBe('export const value = 1;');

  const second = await createHarness(onTestFinished, [], alias);
  const edited = await second.call('edit', {
    path: join(alias, 'src/value.ts'),
    edits: [{ oldText: '= 1', newText: '= 2' }],
  });

  expect(edited.isError).toBe(false);
  expect(JSON.stringify(edited.result)).toContain('RED');
  expect(edited.result).toHaveProperty('details.diff');
});
