import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createSavedReview } from '../../../tests/savedReview.js';
import { readPublicationEvidence } from './evidence.js';
import type { PublicationRequest } from './evidence.js';
import { createGhFake } from './fixtures/ghFake.js';

const git = async (cwd: string, ...commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd });

  return stdout.trim();
};

const commitFile = async (root: string, text: string) => {
  await writeFile(join(root, 'feature.txt'), text);
  await git(root, 'add', 'feature.txt');
  await git(root, 'commit', '--quiet', '-m', 'change feature');

  return git(root, 'rev-parse', 'HEAD');
};

const setUp = async (kind: 'range' | 'workingTree' = 'range') => {
  const root = await createTemporaryRepository(onTestFinished);
  const remote = await mkdtemp(join(tmpdir(), 'tau-pr-evidence-'));

  onTestFinished(() => rm(remote, { recursive: true, force: true }));
  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await git(root, 'config', `url.${remote}.insteadOf`, 'https://github.com/sQVe/tau.git');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');

  const mergeBase = await commitFile(root, 'one\n');

  await git(root, 'push', '--quiet', 'origin', 'main');
  await git(root, 'checkout', '--quiet', '-b', 'feature');
  await commitFile(root, 'two\n');

  const head = await git(root, 'rev-parse', 'HEAD');
  const target = kind === 'range' ? { kind, from: mergeBase, to: head } : { kind, base: mergeBase };
  const directory = await createSavedReview(root, target);

  const fake = createGhFake();

  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  const defaultRequest = { remote: 'origin', review: directory };

  const run = (request: PublicationRequest = defaultRequest) =>
    readPublicationEvidence({ exec: fake.exec, cwd: root, signal: undefined }, root, request);

  return { root, directory, mergeBase, fake, run };
};

const readSavedFiles = async (root: string) => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .filter((path) => !path.startsWith('.git/'))
    .filter((path) => !path.endsWith('/recheck.diff'))
    .toSorted();

  return Promise.all(paths.map(async (path) => [path, await readFile(join(root, path))]));
};

const outputHash = async (root: string, commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, {
    cwd: root,
    encoding: 'buffer',
  });

  return createHash('sha256').update(stdout).digest('hex');
};

const saveCheck = async (root: string, mergeBase: string, body = 'tests passed\n') => {
  const directory = join(root, '.tau', 'pr', 'run-check', 'checks');

  await mkdir(directory, { recursive: true });

  const path = join(directory, 'test.log');
  const head = await git(root, 'rev-parse', 'HEAD');
  const status = await outputHash(root, ['--no-optional-locks', 'status', '--porcelain']);

  const diff = await outputHash(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    mergeBase,
    'HEAD',
  ]);

  await writeFile(path, `HEAD: ${head}\nStatus: ${status}\nDiff: ${diff}\n${body}`);

  return path;
};

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
    gaps: [],
  });

  expect(await readSavedFiles(root)).toEqual(before);
  expect(await readFile(join(directory, 'recheck.diff'))).toEqual(recheck);

  expect(fake.calls.map((call) => call.commandArguments.slice(0, 2))).toEqual([
    ['auth', 'status'],
    ['repo', 'view'],
    ['pr', 'list'],
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
  { header: 'HEAD', field: 'head', length: 40 },
  { header: 'Status', field: 'status', length: 64 },
  { header: 'Diff', field: 'diff', length: 64 },
])('rejects a check log with a changed $header hash', async ({ header, field, length }) => {
  const { root, mergeBase, run } = await setUp();
  const path = await saveCheck(root, mergeBase);
  const text = await readFile(path, 'utf8');
  const pattern = new RegExp(`^${header}: .*`, 'mu');

  await writeFile(path, text.replace(pattern, `${header}: ${'0'.repeat(length)}`));

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.checks).toEqual([
    {
      path,
      matches: false,
      reasons: [{ field, reason: expect.any(String) as unknown }],
      excerpt: null,
      truncated: false,
    },
  ]);

  expect(evidence.gaps).toEqual([]);

  expect(await readSavedFiles(root)).toEqual(before);
});

it('returns only the newest log for a check without gaps from superseded runs', async () => {
  const { root, mergeBase, run } = await setUp();
  const older = await saveCheck(root, mergeBase);
  const currentLog = await readFile(older, 'utf8');
  const newerDirectory = join(root, '.tau', 'pr', 'run-another', 'checks');
  const newer = join(newerDirectory, 'test.log');

  await writeFile(older, currentLog.replace(/^HEAD: .*$/mu, `HEAD: ${'0'.repeat(40)}`));
  await mkdir(newerDirectory, { recursive: true });
  await writeFile(newer, currentLog);
  await utimes(older, 100, 100);
  await utimes(newer, 200, 200);

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.checks).toEqual([
    { path: newer, matches: true, reasons: [], excerpt: 'tests passed', truncated: false },
  ]);

  expect(evidence.gaps).toEqual([]);
  expect(await readSavedFiles(root)).toEqual(before);
});

it('matches the exact status bytes of a dirty worktree', async () => {
  const { root, mergeBase, run } = await setUp();

  await writeFile(join(root, 'feature.txt'), 'dirty\n');

  const path = await saveCheck(root, mergeBase);
  const evidence = await run();

  expect(evidence.checks).toMatchObject([{ path, matches: true, reasons: [] }]);
});

it('rejects a saved check when the worktree status changes', async () => {
  const { root, mergeBase, run } = await setUp();
  const path = await saveCheck(root, mergeBase);

  await writeFile(join(root, 'feature.txt'), 'dirty\n');

  const evidence = await run();

  expect(evidence.checks).toMatchObject([
    { path, matches: false, reasons: [{ field: 'status' }], excerpt: null },
  ]);
});

it('rejects a saved check when the committed head and diff change', async () => {
  const { root, mergeBase, run } = await setUp();
  const path = await saveCheck(root, mergeBase);

  await commitFile(root, 'three\n');

  const evidence = await run();

  expect(evidence.checks).toMatchObject([
    { path, matches: false, reasons: [{ field: 'head' }, { field: 'diff' }], excerpt: null },
  ]);
});

it('rejects a check log without a header', async () => {
  const { root, mergeBase, run } = await setUp();
  const path = await saveCheck(root, mergeBase);

  await writeFile(path, 'passed without a header\n');

  const evidence = await run();

  expect(evidence.checks).toMatchObject([
    { path, matches: false, reasons: [{ field: 'header' }], excerpt: null },
  ]);

  expect(evidence.gaps).toContainEqual({
    kind: 'check',
    path,
    reasons: evidence.checks[0]?.reasons,
  });
});

it('reports noChecks without creating a checks directory', async () => {
  const { root, run } = await setUp();
  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.checks).toEqual([]);
  expect(evidence.gaps).toContainEqual({ kind: 'noChecks' });
  await expect(readdir(join(root, '.tau', 'pr'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readSavedFiles(root)).toEqual(before);
});

it('reports a failed target read and skips comparisons that need the merge base', async () => {
  const { root, mergeBase, fake, run } = await setUp();
  const path = await saveCheck(root, mergeBase);

  fake.failCommand('auth status');

  const before = await readSavedFiles(root);
  const evidence = await run();

  expect(evidence.target).toBeNull();
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

it('keeps a bounded tail of a matching log and reports its cut', async () => {
  const { root, mergeBase, run } = await setUp();
  const body = `${'first\n'.repeat(30)}last\n`;
  const path = await saveCheck(root, mergeBase, body);
  const evidence = await run();

  expect(evidence.checks).toMatchObject([
    { matches: true, excerpt: `${'first\n'.repeat(19)}last`, truncated: true },
  ]);

  expect(evidence.gaps).toContainEqual({ kind: 'checkExcerpt', path });
});

it('reports a missing recheck before the review reader recaptures it', async () => {
  const { directory, run } = await setUp();

  await rm(join(directory, 'recheck.diff'));

  const evidence = await run();

  expect(evidence.reuse).toBeNull();
  expect(evidence.gaps).toContainEqual({ kind: 'reuse', reason: expect.any(String) as unknown });
  expect(evidence.review?.freshness.status).toBe('fresh');
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

it('does not follow linked check logs', async () => {
  const { root, mergeBase, run } = await setUp();
  const path = await saveCheck(root, mergeBase);
  const linked = join(root, '.tau', 'pr', 'run-check', 'checks', 'linked.log');

  await symlink(path, linked);

  const evidence = await run();

  expect(evidence.checks).toMatchObject([
    { path: linked, matches: false, reasons: [{ field: 'read' }], excerpt: null },
    { path, matches: true },
  ]);

  expect(evidence.gaps).toContainEqual({
    kind: 'check',
    path: linked,
    reasons: evidence.checks[0]?.reasons,
  });
});
