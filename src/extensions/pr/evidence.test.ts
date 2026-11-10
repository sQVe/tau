import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { pullRequest as fakePullRequest } from '../../../tests/prGhFake.js';
import {
  commitFile,
  createEvidenceRepository,
  readSavedFiles,
  saveCheck,
} from './fixtures/evidenceRepository.js';

const setUp = (kind?: 'range' | 'workingTree') => createEvidenceRepository(onTestFinished, kind);

it('refuses a stale review with matching bytes', async () => {
  const { root, directory, run } = await setUp();

  await writeFile(join(directory, 'reviewer.md'), 'No findings.\n');
  await git(root, 'commit', '--allow-empty', '--quiet', '-m', 'move head');

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.reuse?.status).toBe('match');
  expect(evidence.review?.freshness.status).toBe('stale');
  expect(evidence.review?.reusable).toBe(false);

  expect(evidence.review?.reusableReasons).toEqual(
    expect.arrayContaining([expect.stringMatching(/freshness/i)]),
  );

  expect(await readSavedFiles(root)).toEqual(before);
});

it('accepts a fresh matching review with worker reports', async () => {
  const { root, directory, run } = await setUp();

  await writeFile(join(directory, 'finder.md'), 'No findings.\n');
  await writeFile(join(directory, 'checker.md'), 'No findings.\n');

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.reuse?.status).toBe('match');

  expect(evidence.review).toMatchObject({
    freshness: { status: 'fresh' },
    reusable: true,
    reusableReasons: [],
  });

  expect(await readSavedFiles(root)).toEqual(before);
});

it('returns own ownership for an open PR by the viewer', async () => {
  const { fake, run } = await setUp();

  fake.pullRequests['github.com/sQVe/tau'] = [fakePullRequest()];

  const evidence = await run();

  expect(evidence).toMatchObject({ ownership: { status: 'own' } });
});

it('uses commits after the merge base for ownership when the only PR is closed', async () => {
  const { root, fake, run } = await setUp();

  await git(root, 'config', 'user.email', 'tau@example.com');
  await git(root, 'commit', '--amend', '--no-edit', '--author=Other <other@example.com>');
  fake.pullRequests['github.com/sQVe/tau'] = [fakePullRequest({ state: 'CLOSED' })];

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.target).toMatchObject({ pr: null, closedPrs: [{ number: 7 }] });
  expect(evidence.ownership).toEqual({ status: 'other', reasons: [] });
  expect(await readSavedFiles(root)).toEqual(before);
});

it('returns unclear ownership when the viewer read fails', async () => {
  const { root, fake, run } = await setUp();

  fake.pullRequests['github.com/sQVe/tau'] = [fakePullRequest()];
  fake.failCommand('api user');

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence).toMatchObject({ ownership: { status: 'unclear' } });
  expect(evidence.ownership.reasons).toEqual([expect.stringContaining('api user')]);
  expect(evidence.target?.pr?.number).toBe(7);
  expect(await readSavedFiles(root)).toEqual(before);
});

it('returns differing paths and stale freshness when the reviewed head moved', async () => {
  const { root, run } = await setUp();

  await commitFile(root, 'three\n');

  const evidence = await run();

  expect(evidence.reuse).toMatchObject({
    status: 'mismatch',
    paths: { differing: ['feature.txt'] },
  });

  expect(evidence.review?.gaps).toContainEqual({
    kind: 'freshness',
    status: 'stale',
    reasons: expect.any(Array) as unknown,
  });
});

it('returns a matching review, matching check log, and PR fields without changing saved files', async () => {
  const { root, directory, mergeBase, fake, run } = await setUp();
  const path = await saveCheck(root, mergeBase);
  const head = await git(root, 'rev-parse', 'HEAD');

  const pullRequest = {
    number: 1,
    state: 'OPEN' as const,
    title: 'ME-511 publication',
    body: 'Fixes AI-304',
    baseRefName: 'main',
    isDraft: true,
    headRefOid: head,
    headOwner: 'sQVe',
    headBranch: 'feature',
  };

  fake.pullRequests['github.com/sQVe/tau'] = [
    pullRequest,
    { ...pullRequest, number: 2, state: 'CLOSED' },
  ];

  const before = await readSavedFiles(root);
  const recheck = await readFile(join(directory, 'recheck.diff'));
  const evidence = await run();

  expect(evidence).toMatchObject({
    target: {
      head: { sha: head },
      base: { branch: 'main' },
      mergeBase,
      pr: { title: pullRequest.title, body: pullRequest.body },
      closedPrs: [{ number: 2, title: pullRequest.title, body: pullRequest.body }],
    },
    branch: 'feature',
    subjects: ['change feature'],
    reuse: { status: 'match' },
    review: { freshness: { status: 'fresh' }, paths: ['feature.txt'] },
    checks: [{ path, matches: true, reasons: [], excerpt: 'tests passed', truncated: false }],
    gaps: [{ kind: 'fullCheck', status: 'missing' }],
  });

  expect(await readSavedFiles(root)).toEqual(before);
  expect(await readFile(join(directory, 'recheck.diff'))).toEqual(recheck);

  expect(fake.calls.map((call) => call.commandArguments.slice(0, 2))).toEqual([
    ['auth', 'status'],
    ['repo', 'view'],
    ['pr', 'list'],
    ['api', 'user'],
  ]);
});

it('reports a stale working tree capture without hiding the reuse result', async () => {
  const { root, run } = await setUp('workingTree');

  await writeFile(join(root, 'feature.txt'), 'uncommitted\n');

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.reuse?.status).toBe('match');
  expect(evidence.review?.freshness.status).toBe('stale');

  expect(evidence.review?.gaps).toContainEqual({
    kind: 'freshness',
    status: 'stale',
    reasons: expect.any(Array) as unknown,
  });

  expect(evidence.gaps).toContainEqual({
    kind: 'reviewEvidence',
    gap: { kind: 'freshness', status: 'stale', reasons: expect.any(Array) as unknown },
  });

  expect(await readSavedFiles(root)).toEqual(before);
});

it('returns noReview when no review was given', async () => {
  const { root, run } = await setUp();
  const before = await readSavedFiles(root);
  const evidence = await run({ remote: 'origin' });

  expect(evidence.target).not.toBeNull();
  expect(evidence.review).toBeNull();
  expect(evidence.reuse).toBeNull();
  expect(evidence.gaps).toContainEqual({ kind: 'noReview' });
  expect(await readSavedFiles(root)).toEqual(before);
});

it.each([
  {
    name: 'missing capture.json',
    prepare: (directory: string) => rm(join(directory, 'capture.json')),
  },
  {
    name: 'malformed capture.json',
    prepare: (directory: string) => writeFile(join(directory, 'capture.json'), '{'),
  },
])('reports $name without changing saved files or hiding check logs', async ({ prepare }) => {
  const { root, directory, mergeBase, run } = await setUp();

  await prepare(directory);
  await saveCheck(root, mergeBase);

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.review).toBeNull();
  expect(evidence.reuse).toBeNull();

  expect(evidence.gaps).toEqual(
    expect.arrayContaining([
      { kind: 'reuse', reason: expect.any(String) as unknown },
      { kind: 'review', reason: expect.any(String) as unknown },
    ]),
  );

  expect(evidence.checks[0]?.matches).toBe(true);
  expect(await readSavedFiles(root)).toEqual(before);
});

it.each([
  { name: 'a normal review', prepare: undefined },
  {
    name: 'a missing capture.json',
    prepare: (directory: string) => rm(join(directory, 'capture.json')),
  },
  {
    name: 'a malformed capture.json',
    prepare: (directory: string) => writeFile(join(directory, 'capture.json'), '{'),
  },
])('runs evidence twice on $name without changing any saved file', async ({ prepare }) => {
  const { root, directory, run } = await setUp();

  await prepare?.(directory);

  const before = await readSavedFiles(root);

  await run();

  expect(await readSavedFiles(root)).toEqual(before);

  await run();

  expect(await readSavedFiles(root)).toEqual(before);
});

it('reports a failed target read and skips comparisons that need the merge base', async () => {
  const { root, mergeBase, fake, run } = await setUp();
  const path = await saveCheck(root, mergeBase);

  fake.failCommand('auth status');

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.target).toBeNull();

  expect(evidence.ownership).toEqual({
    status: 'unclear',
    reasons: [expect.stringContaining('auth status')],
  });

  expect(evidence.subjects).toEqual([]);
  expect(evidence.reuse).toBeNull();
  expect(evidence.review?.freshness.status).toBe('fresh');

  expect(evidence.checks).toMatchObject([
    { path, matches: false, reasons: [{ field: 'current' }] },
  ]);

  expect(evidence.gaps).toContainEqual({ kind: 'target', reason: expect.any(String) as unknown });

  expect(evidence.gaps).toContainEqual({
    kind: 'check',
    path,
    reasons: evidence.checks[0]?.reasons,
  });

  expect(fake.calls).toHaveLength(1);
  expect(await readSavedFiles(root)).toEqual(before);
});

it('reports a missing recheck and leaves it missing', async () => {
  const { directory, run } = await setUp();

  await rm(join(directory, 'recheck.diff'));

  const evidence = await run();

  expect(evidence.reuse).toBeNull();
  expect(evidence.gaps).toContainEqual({ kind: 'reuse', reason: expect.any(String) as unknown });
  expect(evidence.review?.freshness.status).toBe('fresh');
  await expect(readFile(join(directory, 'recheck.diff'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses an invalid review directory without creating any file', async () => {
  const { root, directory, run } = await setUp();
  const before = await readSavedFiles(root);
  const evidence = await run({ remote: 'origin', review: join(directory, 'nested') });

  expect(evidence.review).toBeNull();
  expect(evidence.reuse).toBeNull();
  expect(evidence.gaps).toContainEqual({ kind: 'review', reason: expect.any(String) as unknown });
  expect(await readSavedFiles(root)).toEqual(before);
});

it('lists added markers from the branch diff since the merge base', async () => {
  const { root, run } = await setUp();
  const onlySuffix = '.only';
  const marked = `it${onlySuffix}('works', () => {});`;

  await writeFile(join(root, 'feature.test.ts'), `${marked}\n`);
  await git(root, 'add', 'feature.test.ts');
  await git(root, 'commit', '--quiet', '-m', 'add test');

  const evidence = await run();

  expect(evidence.markers).toEqual([
    { path: 'feature.test.ts', line: 1, marker: '.only(', text: marked },
  ]);
});

it('adds scan gaps from the marker scan to the publication gaps', async () => {
  const { root, run } = await setUp();
  const onlySuffix = '.only';
  const marked = `it${onlySuffix}('works', () => {}); // ${'x'.repeat(2000)}`;

  await writeFile(join(root, 'feature.test.ts'), `${marked}\n`);
  await git(root, 'add', 'feature.test.ts');
  await git(root, 'commit', '--quiet', '-m', 'add test');

  const evidence = await run();

  expect(evidence.markers).toHaveLength(1);

  expect(evidence.gaps).toContainEqual({
    kind: 'reviewEvidence',
    gap: {
      kind: 'truncatedLine',
      path: 'feature.test.ts',
      line: 1,
      kept: 500,
      total: marked.length,
    },
  });
});

it('adds a markers read failure and keeps the rest of the evidence when the diff fails', async () => {
  const { root, run } = await setUp();

  await git(root, 'config', 'diff.algorithm', 'bogus');

  const evidence = await run();

  expect(evidence.markers).toEqual([]);
  expect(evidence.gaps.filter((gap) => gap.kind === 'markers')).toHaveLength(1);
  expect(evidence.branch).toBe('feature');
  expect(evidence.target).not.toBeNull();
});
