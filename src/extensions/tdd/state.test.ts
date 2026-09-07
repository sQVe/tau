import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { TestContext } from 'vitest';
import { expect, it, onTestFinished as registerCleanup } from 'vitest';

import { createEvidenceStore } from './state.js';

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
