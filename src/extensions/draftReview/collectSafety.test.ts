import { link, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { saveCollectedRecord } from './collectedRecord.js';
import { comment, fixture, stagingOf } from './fixtures/reviewFixture.js';

const reviewOnA = async () => {
  const context = await fixture();
  const outside = join(context.repository, 'outside.md');
  const opened = await context.run({ action: 'open', paths: ['.tau/slices/a.md'] });

  if (opened.details.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  const { directory, command } = opened.details;
  const staging = stagingOf(command);

  await context.setSession([comment('on-a', 'slices/a.md')]);
  await writeFile(join(staging, 'slices/a.md'), 'HACKED\n');

  const collect = () => context.run({ action: 'collect', directory });

  return { ...context, outside, directory, staging, collect };
};

const expectRefusedAndKept = async (
  context: Awaited<ReturnType<typeof reviewOnA>>,
  message: RegExp,
) => {
  await expect(context.collect()).rejects.toThrow(message);

  expect(await context.deleted()).toEqual([]);
  expect(await context.records()).toHaveLength(1);
  expect(await readFile(join(context.staging, 'slices/a.md'), 'utf8')).toBe('HACKED\n');
};

it('refuses to stage a file that has another hard link', async () => {
  const { run, repository, real } = await fixture();

  await link(real('slices/a.md'), join(repository, 'outside.md'));

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] })).rejects.toThrow(
    /hard link.*slices\/a\.md/,
  );
});

it('refuses a file that gained a hard link after staging, before deleting or writing anything', async () => {
  const context = await reviewOnA();

  await link(context.real('slices/a.md'), context.outside);
  await expectRefusedAndKept(context, /slices\/a\.md.*hard link/);

  expect(await readFile(context.outside, 'utf8')).toBe('one\ntwo\n');
});

it('refuses a symlink swapped in after staging, before deleting or writing anything', async () => {
  const context = await reviewOnA();

  await writeFile(context.outside, 'one\ntwo\n');
  await rm(context.real('slices/a.md'));
  await symlink(context.outside, context.real('slices/a.md'));
  await expectRefusedAndKept(context, /slices\/a\.md.*symbolic link/);

  expect(await readFile(context.outside, 'utf8')).toBe('one\ntwo\n');
});

it('refuses a symlink swapped in while comments are deleted, and leaves the outside file alone', async () => {
  const context = await reviewOnA();

  await writeFile(context.outside, 'one\ntwo\n');

  await writeFile(
    join(context.data, 'mutate.json'),
    JSON.stringify({ path: context.real('slices/a.md'), linkTo: context.outside }),
  );

  await expect(context.collect()).rejects.toThrow(
    /slices\/a\.md.*symbolic link.*Deleted tuicr comments: on-a\. Written files: none\./,
  );

  expect(await readFile(context.outside, 'utf8')).toBe('one\ntwo\n');
  expect(await context.records()).toHaveLength(1);
});

it('says nothing was deleted or written when the refusal comes before any change', async () => {
  const context = await reviewOnA();

  await link(context.real('slices/a.md'), context.outside);

  await expect(context.collect()).rejects.toThrow(/Nothing was deleted or written\./);
});

it('refuses a dangling symlink at the destination and keeps comments, staging, and the record', async () => {
  const context = await reviewOnA();

  await rm(context.real('slices/a.md'));
  await symlink(join(context.repository, 'absent.md'), context.real('slices/a.md'));
  await expectRefusedAndKept(context, /slices\/a\.md.*symbolic link/);

  expect(await context.deleted()).toEqual([]);
});

it('reports a conflict, not a refusal, when the destination is missing', async () => {
  const context = await reviewOnA();

  await rm(context.real('slices/a.md'));

  const collected = await context.collect();

  expect(collected.details).toMatchObject({ status: 'reviewed', edits: [{ status: 'conflict' }] });
  expect(await context.deleted()).toEqual(['on-a']);
});

it('refuses a file that resolves outside .tau through a directory symlink set up after staging', async () => {
  const context = await reviewOnA();
  const outsideDirectory = join(context.repository, 'outside-slices');

  await mkdir(outsideDirectory);
  await writeFile(join(outsideDirectory, 'a.md'), 'one\ntwo\n');
  await rename(context.real('slices'), context.real('old-slices'));
  await symlink(outsideDirectory, context.real('slices'));
  await expectRefusedAndKept(context, /slices\/a\.md.*outside the \.tau directory/);

  expect(await readFile(join(outsideDirectory, 'a.md'), 'utf8')).toBe('one\ntwo\n');
});

it('does not let an already applied edit block the retry of the rest', async () => {
  const context = await reviewOnA();

  await saveCollectedRecord(context.directory, {
    comments: [],
    edits: [{ path: 'slices/a.md', diff: 'd', staged: 'one\ntwo\n', status: 'applied' }],
  });

  await link(context.real('slices/a.md'), context.outside);

  const collected = await context.collect();

  expect(collected.details).toMatchObject({ edits: [{ status: 'applied' }] });
});

it('refuses a saved edit and comment for a path the review did not stage', async () => {
  const context = await reviewOnA();
  const notReviewed = join(context.repository, 'not-reviewed.md');

  await writeFile(notReviewed, '');

  await saveCollectedRecord(context.directory, {
    comments: [
      {
        sessionPath: join(context.data, 'session.json'),
        id: 'on-a',
        deleted: false,
        path: 'slices/a.md',
        startLine: 1,
        endLine: 1,
        type: 'issue',
        content: 'x',
      },
    ],
    edits: [{ path: '../not-reviewed.md', diff: 'd', staged: 'HACKED\n', status: 'pending' }],
  });

  await expectRefusedAndKept(context, /not-reviewed\.md/);

  expect(await readFile(notReviewed, 'utf8')).toBe('');
});

it('refuses a saved comment for a path the review did not stage', async () => {
  const context = await reviewOnA();

  await saveCollectedRecord(context.directory, {
    comments: [
      {
        sessionPath: join(context.data, 'session.json'),
        id: 'on-c',
        deleted: false,
        path: 'tickets/c.md',
        startLine: 1,
        endLine: 1,
        type: 'issue',
        content: 'x',
      },
    ],
    edits: [],
  });

  await expectRefusedAndKept(context, /tickets\/c\.md/);

  expect(await readFile(context.real('tickets/c.md'), 'utf8')).toBe('sea\n');
});

it('fails and names the file when an original is missing before planning', async () => {
  const context = await reviewOnA();

  await rm(join(context.directory, 'originals/slices/a.md'));
  await expectRefusedAndKept(context, /slices\/a\.md.*original/);

  expect(await readFile(context.real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');
});

it('fails and names the file when an original is missing from a saved plan', async () => {
  const context = await reviewOnA();

  await saveCollectedRecord(context.directory, {
    comments: [],
    edits: [{ path: 'slices/a.md', diff: 'd', staged: 'HACKED\n', status: 'pending' }],
  });

  await rm(join(context.directory, 'originals/slices/a.md'));
  await expectRefusedAndKept(context, /slices\/a\.md.*original/);

  expect(await readFile(context.real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');
  expect((await stat(context.real('slices/a.md'))).nlink).toBe(1);
});
