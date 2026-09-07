import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

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
  expect(await store.read(cwd)).toMatchObject({ focusedPassValid: true, fullPassValid: true });
  await writeFile(join(cwd, 'package.json'), '{}');
  expect(await store.read(cwd)).toMatchObject({ focusedPassValid: false, fullPassValid: false });
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  expect(await store.read(cwd)).toMatchObject({ focusedPassValid: true, fullPassValid: true });
});
