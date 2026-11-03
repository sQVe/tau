import {
  chmod,
  cp,
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLinearFake } from '../../../tests/linearFake.js';
import { noUiContext } from '../../../tests/toolContext.js';
import {
  appliedPlan,
  fixtures,
  outsideDirectory,
  readDetails,
  run,
  savedPlan,
  setUp,
  snapshotDraft,
  temporaryRepository,
} from './fixtures/sliceToolHarness.js';

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const isRoot = process.getuid?.() === 0;

describe('slice tool prepare', () => {
  it('refuses a hard-linked ignore file without changing outside bytes', async () => {
    const root = await temporaryRepository();
    const outside = join(await outsideDirectory(), 'ignore');
    const fake = createLinearFake();

    await writeFile(outside, 'outside bytes\n');
    await mkdir(join(root, '.tau'));
    await link(outside, join(root, '.tau', '.gitignore'));

    await expect(run(fake, noUiContext(root), { action: 'prepare', id: 'me-537' })).rejects.toThrow(
      /hard link/,
    );

    expect(await readFile(outside, 'utf8')).toBe('outside bytes\n');
    expect(await readdir(join(root, '.tau'))).toEqual(['.gitignore']);
    expect(fake.writes()).toEqual([]);
  });

  it('prepares and reuses a start-slice draft without a plan', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = noUiContext(root);

    const { directory } = await run(fake, context, { action: 'prepare', id: 'me-537' });

    expect(directory).toBe(join(root, '.tau', 'slices', 'me-537'));
    expect(await readdir(directory)).toEqual([]);
    expect(await run(fake, context, { action: 'prepare', id: 'me-537' })).toEqual({ directory });

    await writeFile(join(directory, 'start.json'), 'Start the slice.\n');
    await writeFile(join(directory, 'agent-1.md'), 'First task.\n');
    await writeFile(join(directory, 'agent-2.md'), 'Second task.\n');
    const before = await snapshotDraft(directory);

    expect(await run(fake, context, { action: 'prepare', id: 'me-537' })).toEqual({ directory });
    expect(await snapshotDraft(directory)).toEqual(before);
    expect(fake.writes()).toEqual([]);
  });

  it('reuses the draft that records the container', async () => {
    const { root, fake, context, directory } = await appliedPlan();

    const prepared = await run(fake, context, { action: 'prepare', id: 'me-1' });

    expect(prepared.directory).toBe(directory);
    expect(directory.startsWith(join(root, '.tau', 'slices'))).toBe(true);
  });

  it('refuses a reused draft behind a linked .tau', async () => {
    const { root, fake, context } = await appliedPlan();
    const outside = await outsideDirectory();

    await cp(join(root, '.tau'), outside, { recursive: true });
    await rm(join(root, '.tau'), { recursive: true });
    await symlink(outside, join(root, '.tau'));
    const outsidePlan = join(outside, 'slices', 'me-1', 'plan.json');
    const planBefore = await readFile(outsidePlan, 'utf8');

    await expect(run(fake, context, { action: 'prepare', id: 'me-1' })).rejects.toThrow(
      /symlink: \.tau$/,
    );

    expect(await readFile(outsidePlan, 'utf8')).toBe(planBefore);
  });

  it.each(['malformed.json', 'newer.json'])(
    'prepares a new draft next to an unrelated %s draft',
    async (fixture) => {
      const { root, fake, context } = await setUp();
      const unrelated = join(root, '.tau', 'slices', 'unrelated');

      await mkdir(unrelated);
      await copyFile(join(fixtures, fixture), join(unrelated, 'plan.json'));

      const prepared = await run(fake, context, { action: 'prepare', id: 'other-design' });

      expect(prepared.directory).toBe(join(root, '.tau', 'slices', 'other-design'));
    },
  );

  it('refuses a draft named id that records another container', async () => {
    const { fake, context, directory } = await setUp();
    const plan = await savedPlan(directory);

    plan.container.identifier = 'ME-5';
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    await expect(run(fake, context, { action: 'prepare', id: 'planning' })).rejects.toThrow(
      /planning records container ME-5/,
    );
  });

  it('reuses a draft named id that records no container', async () => {
    const { fake, context, directory } = await setUp();

    const prepared = await run(fake, context, { action: 'prepare', id: 'planning' });

    expect(prepared.directory).toBe(directory);
  });

  it.skipIf(isRoot)('refuses to prepare when it cannot list the drafts', async () => {
    const { root, fake, context } = await setUp();
    const slices = join(root, '.tau', 'slices');

    await chmod(slices, 0o300);

    const outcome = await run(fake, context, { action: 'prepare', id: 'other' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    await chmod(slices, 0o755);

    expect(outcome).toMatchObject({ code: 'EACCES' });
    expect(await exists(join(slices, 'other'))).toBe(false);
  });

  it('refuses a selected draft with malformed JSON', async () => {
    const { fake, context, directory } = await setUp('malformed.json');

    await expect(run(fake, context, { action: 'prepare', id: 'planning' })).rejects.toThrow(
      new RegExp(`Malformed slice draft ${join(directory, 'plan.json')}`),
    );
  });

  it.skipIf(isRoot)('refuses a selected draft whose plan.json it cannot read', async () => {
    const { fake, context, directory } = await setUp();
    const plan = join(directory, 'plan.json');

    await chmod(plan, 0o000);

    const outcome = await run(fake, context, { action: 'prepare', id: 'planning' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    await chmod(plan, 0o644);

    expect(outcome).toMatchObject({ code: 'EACCES' });
  });
});

describe('slice tool draft directory', () => {
  it('reads a missing draft without creating anything', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = noUiContext(root);

    await mkdir(join(root, '.tau'));
    await writeFile(join(root, '.tau', 'note.md'), 'Not ignored.\n');

    const result = readDetails(
      await run(fake, context, {
        action: 'read',
        directory: '.tau/slices/missing',
      }),
    );

    expect(result.draft).toBeNull();
    expect(await exists(join(root, '.tau', '.gitignore'))).toBe(false);
    expect(await exists(join(root, '.tau', 'slices'))).toBe(false);
  });

  it('refuses a draft directory nested with a backslash without creating anything', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = noUiContext(root);

    await expect(
      run(fake, context, { action: 'read', directory: String.raw`.tau/slices/parent\child` }),
    ).rejects.toThrow(/must sit directly in \.tau\/slices/);

    expect(await exists(join(root, '.tau'))).toBe(false);
  });

  it('refuses to apply a missing draft without creating anything', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = noUiContext(root);

    await expect(
      run(fake, context, { action: 'apply', directory: '.tau/slices/missing', stateToken: 'any' }),
    ).rejects.toThrow(/does not exist/);

    expect(await exists(join(root, '.tau'))).toBe(false);
    expect(fake.writes()).toEqual([]);
  });

  it.each(
    (['prepare', 'read', 'apply'] as const).flatMap((action) =>
      ['plan.json', 'slice-1.md'].map((file) => [action, file] as const),
    ),
  )('refuses to %s a draft whose %s is a symlink', async (action, file) => {
    const { fake, context, directory } = await setUp();
    const outside = join(await outsideDirectory(), file);

    await copyFile(join(directory, file), outside);
    await rm(join(directory, file));
    await symlink(outside, join(directory, file));
    const before = await readFile(outside, 'utf8');

    const input =
      action === 'prepare'
        ? ({ action, id: 'planning' } as const)
        : ({ action, directory, stateToken: 'any' } as const);

    await expect(run(fake, context, input)).rejects.toThrow(new RegExp(`symlink: .*${file}$`));

    expect(await readFile(outside, 'utf8')).toBe(before);
    expect(fake.writes()).toEqual([]);
  });

  it.each(['read', 'apply'] as const)(
    'refuses to %s a draft behind a linked .tau/slices',
    async (action) => {
      const { root, fake, context, directory } = await setUp();
      const outside = await outsideDirectory();

      await cp(join(root, '.tau', 'slices'), outside, { recursive: true });
      await rm(join(root, '.tau', 'slices'), { recursive: true });
      await symlink(outside, join(root, '.tau', 'slices'));
      const planBefore = await readFile(join(outside, 'planning', 'plan.json'), 'utf8');

      await expect(run(fake, context, { action, directory, stateToken: 'any' })).rejects.toThrow(
        /symlink: \.tau\/slices$/,
      );

      expect(await readFile(join(outside, 'planning', 'plan.json'), 'utf8')).toBe(planBefore);
      expect(fake.writes()).toEqual([]);
    },
  );
});
