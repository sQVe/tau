import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createCodeReviewTool } from '../src/extensions/codeReview/tool.js';
import type { CodeReviewInput } from '../src/extensions/codeReview/tool.js';
import { createGhFake } from '../src/extensions/pr/fixtures/ghFake.js';
import { createPrTool } from '../src/extensions/pr/tool.js';
import type { PrInput } from '../src/extensions/pr/tool.js';
import { createTemporaryRepository } from './gitRepository.js';
import { noUiContext } from './toolContext.js';

const git = async (cwd: string, ...commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd });

  return stdout.trim();
};

const runCodeReview = async (root: string, input: CodeReviewInput) => {
  const tool = createCodeReviewTool();
  const result = await tool.execute('call', input, undefined, undefined, noUiContext(root));

  return result.details;
};

const commitFile = async (root: string, path: string, text: string) => {
  await writeFile(join(root, path), text);
  await git(root, 'add', path);
  await git(root, 'commit', '--quiet', '-m', `change ${path}`);

  return git(root, 'rev-parse', 'HEAD');
};

// A feature branch that changes feature.txt from forkPoint, with an empty review directory.
const setUpReview = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await commitFile(root, 'other.txt', 'other\n');

  const forkPoint = await commitFile(root, 'feature.txt', 'one\n');

  await git(root, 'checkout', '--quiet', '-b', 'feature');
  await commitFile(root, 'feature.txt', 'two\n');

  const { directory } = (await runCodeReview(root, { action: 'prepare' })) as {
    directory: string;
  };

  await writeFile(join(directory, 'input.md'), '# Review input\n\n## Capture\n');

  const run = async (input: PrInput) => {
    const tool = createPrTool(createGhFake().exec);
    const result = await tool.execute('call', input, undefined, undefined, noUiContext(root));

    return result.details;
  };

  return { root, directory, forkPoint, run };
};

// The name and bytes of each file in the review directory.
const readEvidence = async (directory: string) =>
  Promise.all(
    (await readdir(directory))
      .toSorted()
      .map(async (name) => [name, await readFile(join(directory, name))] as const),
  );

// Captures changes from forkPoint and writes recheck.diff with freshness.
const captureReview = async (
  root: string,
  directory: string,
  forkPoint: string,
  kind: 'range' | 'workingTree' = 'range',
) => {
  const to = await git(root, 'rev-parse', 'HEAD');
  const target = kind === 'range' ? { kind, from: forkPoint, to } : { kind, base: forkPoint };

  await runCodeReview(root, {
    action: 'capture',
    directory,
    target,
  });

  await runCodeReview(root, { action: 'freshness', directory });
};

const editRecord = async (directory: string, changes: Record<string, unknown>) => {
  const path = join(directory, 'capture.json');
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

  await writeFile(path, JSON.stringify({ ...record, ...changes }));
};

const noPaths = { differing: [], missing: [], extra: [] };

it('reuses a review after a rebase onto a base that changes other files', async () => {
  const { root, directory, forkPoint, run } = await setUpReview();

  await captureReview(root, directory, forkPoint);
  await writeFile(join(directory, 'finder.md'), 'Findings.\n');
  await writeFile(join(directory, 'checker.md'), 'Checked.\n');
  await git(root, 'checkout', '--quiet', 'main');

  const newBase = await commitFile(root, 'other.txt', 'changed\n');

  await git(root, 'checkout', '--quiet', 'feature');
  await git(root, 'rebase', '--quiet', 'main');

  const evidence = await readEvidence(directory);
  const details = await run({ action: 'reuse', directory, mergeBase: newBase });

  expect(await readEvidence(directory)).toEqual(evidence);

  expect(details).toEqual({
    status: 'match',
    reasons: [],
    recordedBase: forkPoint,
    paths: noPaths,
    reports: ['finder.md', 'checker.md'],
  });
});

it('reuses an unchanged review in a SHA-256 repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-reuse-sha256-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '--quiet', '--initial-branch=main', '--object-format=sha256');

  const forkPoint = await commitFile(root, 'feature.txt', 'one\n');

  await git(root, 'checkout', '--quiet', '-b', 'feature');
  await commitFile(root, 'feature.txt', 'two\n');

  const { directory } = (await runCodeReview(root, { action: 'prepare' })) as {
    directory: string;
  };

  await writeFile(join(directory, 'input.md'), '# Review input\n\n## Capture\n');
  await captureReview(root, directory, forkPoint);

  const evidence = await readEvidence(directory);
  const tool = createPrTool(createGhFake().exec);

  const result = await tool.execute(
    'call',
    { action: 'reuse', directory, mergeBase: forkPoint },
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(result.details).toMatchObject({ status: 'match', reasons: [], paths: noPaths });
  expect(await readEvidence(directory)).toEqual(evidence);
});

it('refuses reuse when a file changed after the review', async () => {
  const { root, directory, forkPoint, run } = await setUpReview();

  await captureReview(root, directory, forkPoint);
  await writeFile(join(directory, 'reviewer.md'), 'Reviewed.\n');
  await commitFile(root, 'feature.txt', 'three\n');

  const evidence = await readEvidence(directory);
  const details = await run({ action: 'reuse', directory, mergeBase: forkPoint });

  expect(await readEvidence(directory)).toEqual(evidence);

  expect(details).toMatchObject({
    status: 'mismatch',
    paths: { ...noPaths, differing: ['feature.txt'] },
    reports: ['reviewer.md'],
  });
});

it('refuses reuse when recheck.diff is replaced after reuse reads it', async () => {
  const { root, directory, forkPoint, run } = await setUpReview();

  await captureReview(root, directory, forkPoint, 'workingTree');

  const recheckPath = join(directory, 'recheck.diff');
  const reviewedBytes = await readFile(recheckPath);
  const wrapperDirectory = await mkdtemp(join(tmpdir(), 'tau-reuse-race-'));

  onTestFinished(() => rm(wrapperDirectory, { recursive: true, force: true }));

  const reviewedPath = join(wrapperDirectory, 'reviewed.diff');

  await writeFile(reviewedPath, reviewedBytes);
  await commitFile(root, 'feature.txt', 'three\n');
  await runCodeReview(root, { action: 'freshness', directory });

  const { stdout } = await promisify(execFile)('sh', ['-c', 'command -v git']);
  const realGit = stdout.trim();

  const script = [
    '#!/bin/sh',
    `if [ "$1" = hash-object ]; then cp '${reviewedPath}' '${recheckPath}'; fi`,
    `exec '${realGit}' "$@"`,
  ].join('\n');

  await writeFile(join(wrapperDirectory, 'git'), `${script}\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${wrapperDirectory}:${process.env['PATH'] ?? ''}`);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const record = await readFile(join(directory, 'capture.json'));
  const head = await git(root, 'rev-parse', 'HEAD');
  const details = await run({ action: 'reuse', directory, mergeBase: forkPoint });

  expect(details).toMatchObject({ status: 'mismatch', paths: noPaths });
  expect(await readFile(join(directory, 'capture.json'))).toEqual(record);
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
});

it('refuses reuse when recheck.diff does not have the recorded hash', async () => {
  const { root, directory, forkPoint, run } = await setUpReview();

  await captureReview(root, directory, forkPoint);
  await editRecord(directory, { hash: '0'.repeat(40) });

  const details = await run({ action: 'reuse', directory, mergeBase: forkPoint });

  expect(details).toMatchObject({ status: 'mismatch', paths: noPaths });
  expect(details['reasons']).toHaveLength(1);
});

it('refuses reuse when the recorded base is not an ancestor of the merge base', async () => {
  const { root, directory, forkPoint, run } = await setUpReview();

  await captureReview(root, directory, forkPoint);
  await git(root, 'checkout', '--quiet', '-b', 'side', 'main~1');

  const side = await commitFile(root, 'side.txt', 'side\n');

  await git(root, 'checkout', '--quiet', 'feature');
  await editRecord(directory, { base: side });

  const details = await run({ action: 'reuse', directory, mergeBase: forkPoint });

  expect(details).toMatchObject({ status: 'mismatch', recordedBase: side, paths: noPaths });
  expect(details['reasons']).toHaveLength(1);
});

it('refuses reuse of a root commit review', async () => {
  const { root, directory, forkPoint, run } = await setUpReview();

  await captureReview(root, directory, forkPoint);
  await editRecord(directory, { base: null });

  const details = await run({ action: 'reuse', directory, mergeBase: forkPoint });

  expect(details).toMatchObject({ status: 'mismatch', recordedBase: null, paths: noPaths });
  expect(details['reasons']).toHaveLength(1);
});

it.each([
  { problem: 'no capture.json', prepare: async () => {}, error: 'No capture record' },
  {
    problem: 'a malformed capture.json',
    prepare: (directory: string) => writeFile(join(directory, 'capture.json'), '{'),
    error: 'Malformed capture record',
  },
  {
    problem: 'no recheck.diff',
    prepare: async (directory: string, root: string, forkPoint: string) => {
      await captureReview(root, directory, forkPoint);
      await rm(join(directory, 'recheck.diff'));
    },
    error: 'No recheck.diff',
  },
])('fails reuse on $problem', async ({ prepare, error }) => {
  const { root, directory, forkPoint, run } = await setUpReview();

  await prepare(directory, root, forkPoint);

  const evidence = await readEvidence(directory);

  await expect(run({ action: 'reuse', directory, mergeBase: forkPoint })).rejects.toThrow(error);
  expect(await readEvidence(directory)).toEqual(evidence);
});

it('refuses reuse of a directory outside .tau/workers/review-*', async () => {
  const { root, forkPoint, run } = await setUpReview();
  const directory = join(root, '.tau', 'workers', 'other');

  await mkdir(directory);

  await expect(run({ action: 'reuse', directory, mergeBase: forkPoint })).rejects.toThrow(
    'The review directory must be .tau/workers/review-*',
  );
});

it('refuses reuse of a review directory reached through a symlink', async () => {
  const { root, directory, forkPoint, run } = await setUpReview();
  const linked = join(root, '.tau', 'workers', 'review-linked');

  await captureReview(root, directory, forkPoint);
  await symlink(directory, linked);

  await expect(run({ action: 'reuse', directory: linked, mergeBase: forkPoint })).rejects.toThrow(
    'symlink',
  );
});

it('reuses a working tree review that Git printed with mnemonic prefixes', async () => {
  const { root, directory, forkPoint, run } = await setUpReview();

  await git(root, 'config', 'diff.mnemonicPrefix', 'true');

  await runCodeReview(root, {
    action: 'capture',
    directory,
    target: { kind: 'workingTree', base: forkPoint },
  });

  await runCodeReview(root, { action: 'freshness', directory });

  const details = await run({ action: 'reuse', directory, mergeBase: forkPoint });

  expect(details).toMatchObject({ status: 'match', paths: noPaths });
});
