import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { expect, it, onTestFinished as registerCleanup, vi } from 'vitest';

import { guardToolCall } from './guard.js';
import { createEvidenceStore, tddGateStatus } from './state.js';

// Every test here spawns real vitest children; the default 5s budget flakes on slow machines.
vi.setConfig({ testTimeout: 120_000 });

it('derives validity from current bytes and accepts restored content', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-evidence-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await symlink(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'vite.config.ts'), 'export default {};');
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; it('required', () => expect(1).toBe(2));",
  );
  const store = createEvidenceStore();
  await store.run(
    cwd,
    { behavior: 'behavior', testFullName: 'required', files: ['behavior.test.ts'] },
    'focused',
  );
  expect((await store.read(cwd)).implementationAllowed).toBe(true);
  for (const file of ['behavior.test.ts', 'vite.config.ts', 'package.json']) {
    const path = join(cwd, file);
    const original = await readFile(path);
    await writeFile(path, 'changed');
    expect((await store.read(cwd)).implementationAllowed).toBe(false);
    await writeFile(path, original);
    expect((await store.read(cwd)).implementationAllowed).toBe(true);
  }
  const snapshot = await store.read(cwd);
  expect(snapshot.evidence.red?.before[resolve(import.meta.dirname, 'config.ts')]).toMatch(
    /^[a-f0-9]{64}$/,
  );
  snapshot.evidence.red = null;
  expect((await store.read(cwd)).implementationAllowed).toBe(true);
  await store.run(
    cwd,
    { behavior: 'different', testFullName: 'absent', files: ['behavior.test.ts'] },
    'focused',
  );
  expect((await store.read(cwd)).implementationAllowed).toBe(false);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required', () => {});",
  );
  const behavior = { behavior: 'passing', testFullName: 'required', files: ['behavior.test.ts'] };
  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');
  expect(await store.read(cwd)).toMatchObject({ focusedPassValid: false, fullPassValid: false });
  await writeFile(join(cwd, 'package.json'), '{}');
  expect(await store.read(cwd)).toMatchObject({ focusedPassValid: false, fullPassValid: false });
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  expect(await store.read(cwd)).toMatchObject({ focusedPassValid: false, fullPassValid: false });
});

it('turns the gate off until a test runner resolves from the worktree', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-no-runner-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  const store = createEvidenceStore();

  expect((await store.read(cwd)).notice).toBe(`no test runner resolves from ${cwd}`);

  // An install leaves package.json untouched, so the absent answer must not be cached.
  await symlink(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
  expect((await store.read(cwd)).notice).toBeUndefined();

  await rm(join(cwd, 'node_modules'));
  expect((await store.read(cwd)).notice).toBeUndefined();
  await writeFile(join(cwd, 'package.json'), '{"type":"module","name":"gated"}');
  expect((await store.read(cwd)).notice).toBe(`no test runner resolves from ${cwd}`);
});

const createHarness = async (cleanup: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-cycle-'));
  cleanup(() => rm(cwd, { recursive: true, force: true }));
  await symlink(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'vite.config.ts'), 'export default {};');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('required', () => expect(value).toBe(1));",
  );
  const store = createEvidenceStore();
  const behavior = { behavior: 'behavior', testFullName: 'required', files: ['behavior.test.ts'] };
  return { cwd, store, behavior };
};

it('reloads recorded evidence into a new store for the same worktree', async ({
  onTestFinished,
}) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await store.run(cwd, behavior, 'focused');
  expect(await createEvidenceStore().read(cwd)).toMatchObject({
    phase: 'red',
    implementationAllowed: true,
  });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');
  expect(await createEvidenceStore().read(cwd)).toMatchObject({
    phase: 'verified',
    fullPassValid: true,
  });
});

it('keeps the stored evidence loadable after an interrupted write', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await store.run(cwd, behavior, 'focused');
  await writeFile(join(cwd, '.tau/state.json.tmp'), '{"tdd":{"active"');
  expect(JSON.parse(await readFile(join(cwd, '.tau/state.json'), 'utf8'))).toHaveProperty('tdd');
  expect(await createEvidenceStore().read(cwd)).toMatchObject({
    phase: 'red',
    implementationAllowed: true,
  });
});

it('keeps evidence out of another worktree', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const other = await createHarness(onTestFinished);
  await store.run(cwd, behavior, 'focused');
  expect(await store.read(other.cwd)).toMatchObject({
    phase: 'locked',
    implementationAllowed: false,
  });
  expect(await createEvidenceStore().read(other.cwd)).toMatchObject({ phase: 'locked' });
});

it('fails loudly when the stored evidence is unreadable', async ({ onTestFinished }) => {
  const { cwd } = await createHarness(onTestFinished);
  await mkdir(join(cwd, '.tau'));
  await writeFile(join(cwd, '.tau/state.json'), '{ not json');
  await expect(createEvidenceStore().read(cwd)).rejects.toThrow(join(cwd, '.tau/state.json'));
});

it('reads the repaired evidence after a failed load', async ({ onTestFinished }) => {
  const { cwd } = await createHarness(onTestFinished);
  await mkdir(join(cwd, '.tau'));
  await writeFile(join(cwd, '.tau/state.json'), '{ not json');
  const store = createEvidenceStore();
  await expect(store.read(cwd)).rejects.toThrow(join(cwd, '.tau/state.json'));

  await writeFile(join(cwd, '.tau/state.json'), '{"tdd":{"reds":[],"active":null}}');

  expect(await store.read(cwd)).toMatchObject({ phase: 'locked' });
});

it('leaves the recorded evidence untouched when a run is aborted', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const red = await store.run(cwd, behavior, 'focused');

  const aborted = await store.run(cwd, behavior, 'full', AbortSignal.abort());

  expect(aborted).toMatchObject({ kind: 'cancelled', phase: 'red' });
  expect(await store.read(cwd)).toMatchObject({
    phase: 'red',
    evidence: { red: red.evidence.red, latestRun: red.evidence.latestRun },
  });
});

it('requires RED and a final full pass to verify', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  expect(await store.run(cwd, behavior, 'full')).toMatchObject({
    phase: 'locked',
    fullPassValid: false,
  });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');
  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    phase: 'red',
    fullPassValid: false,
  });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    phase: 'green',
    fullPassValid: false,
  });
  await writeFile(
    join(cwd, 'other.test.ts'),
    "import { it, expect } from 'vitest'; it('other', () => expect(1).toBe(2));",
  );
  expect(await store.run(cwd, behavior, 'full')).toMatchObject({
    phase: 'green',
    fullPassValid: false,
  });
  await writeFile(
    join(cwd, 'other.test.ts'),
    "import { it } from 'vitest'; it('other', () => {});",
  );
  expect(await store.run(cwd, behavior, 'full')).toMatchObject({
    phase: 'verified',
    fullPassValid: true,
  });
});

it('preserves RED but invalidates passes after production changes', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const red = await store.run(cwd, behavior, 'focused');
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  expect(await store.read(cwd)).toMatchObject({ phase: 'red', implementationAllowed: true });
  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');
  expect(await store.read(cwd)).toMatchObject({ phase: 'verified' });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');
  expect(await store.read(cwd)).toMatchObject({
    phase: 'red',
    focusedPassValid: false,
    fullPassValid: false,
    evidence: { red: red.evidence.red },
  });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');
  await writeFile(join(cwd, 'src/added.ts'), 'export const added = 1;');
  expect(await store.read(cwd)).toMatchObject({
    phase: 'red',
    fullPassValid: false,
    focusedPassValid: false,
  });
  await rm(join(cwd, 'src/added.ts'));
  await rm(join(cwd, 'src/value.ts'));
  expect(await store.read(cwd)).toMatchObject({
    phase: 'red',
    fullPassValid: false,
    focusedPassValid: false,
  });
});

it('re-proves amended tests after reverting production without replacing the store', async ({
  onTestFinished,
}) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await store.run(cwd, behavior, 'focused');
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  await store.run(cwd, behavior, 'focused');
  const test = join(cwd, 'behavior.test.ts');
  await writeFile(test, (await readFile(test, 'utf8')).replace('toBe(1)', 'toBeGreaterThan(0)'));
  expect(await store.read(cwd)).toMatchObject({
    phase: 'locked',
    implementationAllowed: false,
    focusedPassValid: false,
  });
  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    kind: 'pass',
    phase: 'locked',
    implementationAllowed: false,
  });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');
  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    kind: 'fail',
    phase: 'red',
    implementationAllowed: true,
  });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({ phase: 'green' });
  expect(await store.run(cwd, behavior, 'full')).toMatchObject({ phase: 'verified' });
});

it.each(['skip', 'delete', 'amend'])(
  'requires earlier RED to remain intact after %s',
  async (change) => {
    const { cwd, store, behavior } = await createHarness(registerCleanup);
    await writeFile(
      join(cwd, 'second.test.ts'),
      "import { it, expect } from 'vitest'; import { value } from './src/value'; it('second', () => expect(value).toBeGreaterThanOrEqual(2));",
    );
    await store.run(cwd, behavior, 'focused');
    await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
    await store.run(cwd, behavior, 'focused');
    const second = { behavior: 'second', testFullName: 'second', files: ['second.test.ts'] };
    await store.run(cwd, second, 'focused');
    await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');
    await store.run(cwd, second, 'focused');
    const path = join(cwd, 'behavior.test.ts');
    if (change === 'delete') await rm(path);
    else
      await writeFile(
        path,
        (await readFile(path, 'utf8')).replace(
          change === 'skip' ? "it('required'" : 'toBe(1)',
          change === 'skip' ? "it.skip('required'" : 'toBe(2)',
        ),
      );
    expect(await store.run(cwd, second, 'full')).toMatchObject({
      kind: 'pass',
      fullPassValid: false,
    });
  },
);

it('drops earlier REDs once a verified full pass closes the task', async ({ onTestFinished }) => {
  const { cwd, store } = await createHarness(onTestFinished);
  await rm(join(cwd, 'behavior.test.ts'));
  const cycle = async (index: number) => {
    const behavior = {
      behavior: `behavior ${index}`,
      testFullName: `behavior ${index}`,
      files: [`behavior${index}.test.ts`],
    };
    await writeFile(
      join(cwd, behavior.files[0]!),
      `import { it, expect } from 'vitest'; import { value } from './src/value'; it('behavior ${index}', () => expect(value).toBeGreaterThanOrEqual(${index}));`,
    );
    expect(await store.run(cwd, behavior, 'focused')).toMatchObject({ phase: 'red' });
    await writeFile(join(cwd, 'src/value.ts'), `export const value = ${index};`);
    await store.run(cwd, behavior, 'focused');
    return store.run(cwd, behavior, 'full');
  };
  for (const index of [1, 2, 3]) {
    expect(await cycle(index)).toMatchObject({ phase: 'verified' });
  }
  const path = join(cwd, 'behavior1.test.ts');
  await writeFile(path, (await readFile(path, 'utf8')).replaceAll('behavior 1', 'renamed'));

  expect(await cycle(4)).toMatchObject({ phase: 'verified', fullPassValid: true });
});

it('rejects a skipped earlier RED even when its test hash is unchanged', async ({
  onTestFinished,
}) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it.skipIf(value === 2)('required', () => expect(value).toBeGreaterThanOrEqual(1));",
  );
  await writeFile(
    join(cwd, 'second.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('second', () => expect(value).toBe(2));",
  );
  await store.run(cwd, behavior, 'focused');
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  await store.run(cwd, behavior, 'focused');
  const second = { behavior: 'second', testFullName: 'second', files: ['second.test.ts'] };
  await store.run(cwd, second, 'focused');
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');
  await store.run(cwd, second, 'focused');
  expect(await store.run(cwd, second, 'full')).toMatchObject({
    kind: 'pass',
    phase: 'green',
    fullPassValid: false,
  });
});

it('renews a shared test file only for the RED that failed inside it', async ({
  onTestFinished,
}) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await store.run(cwd, behavior, 'focused');
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  await store.run(cwd, behavior, 'focused');
  const path = join(cwd, 'behavior.test.ts');
  await writeFile(path, (await readFile(path, 'utf8')).replace('toBe(1)', 'toBeGreaterThan(0)'));
  await writeFile(
    join(cwd, 'second.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('second', () => expect(value).toBe(2));",
  );
  const second = {
    behavior: 'second',
    testFullName: 'second',
    files: ['second.test.ts', 'behavior.test.ts'],
  };
  expect(await store.run(cwd, second, 'focused')).toMatchObject({ phase: 'red' });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');
  await store.run(cwd, second, 'focused');

  expect(await store.run(cwd, second, 'full')).toMatchObject({
    kind: 'pass',
    fullPassValid: false,
  });
});

it('treats the same behavior with reordered files as unchanged', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'second.test.ts'),
    "import { it } from 'vitest'; it('second', () => {});",
  );
  const files = ['behavior.test.ts', 'second.test.ts'];
  expect(await store.run(cwd, { ...behavior, files }, 'focused')).toMatchObject({ phase: 'red' });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  expect(await store.run(cwd, { ...behavior, files: files.toReversed() }, 'focused')).toMatchObject(
    { phase: 'green' },
  );
});

it('never accepts a missing required test file as evidence', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const selection = { ...behavior, files: [...behavior.files, 'deleted.test.ts'] };
  expect(await store.run(cwd, selection, 'focused')).toMatchObject({
    phase: 'locked',
    implementationAllowed: false,
    evidence: { red: null },
  });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  expect(await store.run(cwd, selection, 'focused')).toMatchObject({ focusedPassValid: false });
  expect(await store.run(cwd, selection, 'full')).toMatchObject({
    phase: 'locked',
    fullPassValid: false,
  });
});

it('invalidates verification when the rest of the suite changes', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await store.run(cwd, behavior, 'focused');
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');
  const path = join(cwd, 'other.test.ts');
  await writeFile(path, "import { it } from 'vitest'; it('other', () => {});");
  expect(await store.read(cwd)).toMatchObject({ phase: 'green', fullPassValid: false });
  await store.run(cwd, behavior, 'full');
  await writeFile(path, "import { it } from 'vitest'; it('changed', () => {});");
  expect(await store.read(cwd)).toMatchObject({ phase: 'green', fullPassValid: false });
  await store.run(cwd, behavior, 'full');
  await rm(path);
  expect(await store.read(cwd)).toMatchObject({ phase: 'green', fullPassValid: false });
});

it.each(['skip', 'todo', 'delete'])(
  'rejects a required test changed to %s at both steps',
  async (change) => {
    const { cwd, store, behavior } = await createHarness(registerCleanup);
    await store.run(cwd, behavior, 'focused');
    await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
    await store.run(cwd, behavior, 'focused');
    const path = join(cwd, 'behavior.test.ts');
    if (change === 'delete') await rm(path);
    else
      await writeFile(
        path,
        (await readFile(path, 'utf8')).replace("it('required'", `it.${change}('required'`),
      );
    expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
      phase: 'locked',
      focusedPassValid: false,
      implementationAllowed: false,
    });
    expect(await store.run(cwd, behavior, 'full')).toMatchObject({
      phase: 'locked',
      fullPassValid: false,
    });
  },
);

it('records nothing when one file holds two tests with the same full name', async ({
  onTestFinished,
}) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value';" +
      " it('required', () => expect(value).toBe(1)); it('required', () => expect(value).toBe(0));",
  );

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    kind: 'fail',
    phase: 'locked',
    implementationAllowed: false,
    evidence: { red: null },
  });
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    phase: 'locked',
    focusedPassValid: false,
  });
});

it('requires the same failing test file when full names collide', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it.skipIf(value === 1)('required', () => expect(value).toBe(1));",
  );
  await writeFile(
    join(cwd, 'other.test.ts'),
    "import { it } from 'vitest'; it('required', () => {});",
  );
  const selection = { ...behavior, files: [...behavior.files, 'other.test.ts'] };
  await store.run(cwd, selection, 'focused');
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  expect(await store.run(cwd, selection, 'focused')).toMatchObject({
    phase: 'red',
    focusedPassValid: false,
  });
  expect(await store.run(cwd, selection, 'full')).toMatchObject({
    phase: 'red',
    fullPassValid: false,
  });
});

it('turns the gate off through the switch and back on', async ({ onTestFinished }) => {
  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const write: ToolCallEvent = {
    type: 'tool_call',
    toolCallId: 'call-1',
    toolName: 'write',
    input: { path: 'src/value.ts' },
  };
  expect((await guardToolCall(write, cwd, store))?.block).toBe(true);

  await store.setGate(cwd, 'off');

  const off = await store.read(cwd);
  expect(off.phase).toBe('locked');
  expect(off.notice).toMatch(/^TDD gate off since \d{4}-/);
  expect(await guardToolCall(write, cwd, store)).toBeUndefined();
  expect(await tddGateStatus(cwd)).toBe(off.notice);
  expect((await createEvidenceStore().read(cwd)).notice).toBe(off.notice);

  await store.run(cwd, behavior, 'focused');
  await store.setGate(cwd, 'on');

  const on = await store.read(cwd);
  expect(on.notice).toBeUndefined();
  expect(on.phase).toBe('red');
  expect(on.evidence.red?.report.kind).toBe('fail');
  expect(await tddGateStatus(cwd)).toBeUndefined();
});
