import { mkdir, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import {
  commitFile,
  createEvidenceRepository,
  gapsWithoutFullCheck,
  readSavedFiles,
  saveCheck,
  saveFullCheck,
} from './fixtures/evidenceRepository.js';

const setUp = (kind?: 'range' | 'workingTree') => createEvidenceRepository(onTestFinished, kind);

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

  expect(gapsWithoutFullCheck(evidence)).toEqual([]);

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

  expect(gapsWithoutFullCheck(evidence)).toEqual([]);
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

it.each([
  {
    name: 'passed',
    passed: true,
    gaps: [],
  },
  {
    name: 'failed',
    passed: false,
    gaps: [{ kind: 'fullCheck', status: 'failed' }],
  },
])('reads a $name full check record with its log excerpt', async ({ name, passed, gaps }) => {
  const { root, run } = await setUp();
  const logPath = await saveFullCheck(root, passed);
  const evidence = await run();

  expect(evidence.fullCheck).toEqual({
    status: name,
    logPath,
    argv: ['pnpm', 'check'],
    excerpt: 'compiling\nall done',
    truncated: false,
  });

  expect(evidence.checks).toEqual([]);
  expect(evidence.gaps).toEqual(gaps);
});

it('reports a missing full check record when the tree changed after the run', async () => {
  const { root, run } = await setUp();

  await saveFullCheck(root, true);
  await writeFile(join(root, 'feature.txt'), 'edited\n');

  const evidence = await run();

  expect(evidence.fullCheck).toEqual({ status: 'missing' });
  expect(evidence.gaps).toContainEqual({ kind: 'fullCheck', status: 'missing' });
});

it('reports a missing full check record for a passing record of another command', async () => {
  const { root, run } = await setUp();

  await saveFullCheck(root, true, ['pnpm', 'other']);

  const evidence = await run();

  expect(evidence.fullCheck).toEqual({ status: 'missing' });
  expect(evidence.gaps).toContainEqual({ kind: 'fullCheck', status: 'missing' });
});

it('reports a missing full check when the project is not trusted', async () => {
  const { root, run } = await setUp();

  await saveFullCheck(root, true);

  const evidence = await run(undefined, false);

  expect(evidence.fullCheck).toEqual({ status: 'missing' });
  expect(evidence.gaps).toContainEqual({ kind: 'fullCheck', status: 'missing' });
});

it('reports a malformed full check record', async () => {
  const { root, run } = await setUp();
  const logPath = await saveFullCheck(root, true);

  await writeFile(logPath.replace(/\.log$/u, '.json'), '{');

  const evidence = await run();

  expect(evidence.fullCheck).toEqual({ status: 'malformed' });
  expect(evidence.gaps).toContainEqual({ kind: 'fullCheck', status: 'malformed' });
});
