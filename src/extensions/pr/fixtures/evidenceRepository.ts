import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import type { onTestFinished } from 'vitest';

import { githubOrigin, serveGithubOriginFrom } from '../../../../tests/githubOriginFake.js';
import { createTemporaryRepository, git } from '../../../../tests/gitRepository.js';
import { createSavedReview } from '../../../../tests/savedReview.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { saveCheckRecord } from '../../../checkRecord/checkRecord.js';
import { readCheckState } from '../../../checkRecord/identity.js';
import { readPublicationEvidence } from '../evidence.js';
import type { PublicationEvidence, PublicationRequest } from '../evidence.js';
import { createGhFake } from './ghFake.js';
import type { GhFake } from './ghFake.js';

type RegisterCleanup = typeof onTestFinished;

interface EvidenceRepository {
  root: string;
  directory: string;
  mergeBase: string;
  fake: GhFake;
  run: (request?: PublicationRequest, projectTrusted?: boolean) => Promise<PublicationEvidence>;
}

export const commitFile = async (root: string, text: string): Promise<string> => {
  await writeFile(join(root, 'feature.txt'), text);
  await git(root, 'add', 'feature.txt');
  await git(root, 'commit', '--quiet', '-m', 'change feature');

  return git(root, 'rev-parse', 'HEAD');
};

export const createEvidenceRepository = async (
  registerCleanup: RegisterCleanup,
  kind: 'range' | 'workingTree' = 'range',
): Promise<EvidenceRepository> => {
  const root = await createTemporaryRepository(registerCleanup);
  const remote = temporaryDirectory(registerCleanup, 'tau-pr-evidence-');

  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await serveGithubOriginFrom(remote, registerCleanup);
  await git(root, 'remote', 'add', 'origin', githubOrigin);

  const mergeBase = await commitFile(root, 'one\n');

  await git(root, 'push', '--quiet', 'origin', 'main');
  await git(root, 'checkout', '--quiet', '-b', 'feature');
  await commitFile(root, 'two\n');

  const head = await git(root, 'rev-parse', 'HEAD');
  const target = kind === 'range' ? { kind, from: mergeBase, to: head } : { kind, base: mergeBase };
  const directory = await createSavedReview(root, target);

  const fake = createGhFake();

  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  const agentDirectory = temporaryDirectory(registerCleanup, 'tau-pr-evidence-agent-');

  await mkdir(join(root, '.pi'));

  await writeFile(
    join(root, '.pi', 'tau.json'),
    JSON.stringify({ fullCheck: { argv: ['pnpm', 'check'] } }),
  );

  const config = {
    location: { cwd: root, agentDirectory, projectTrusted: true },
    ui: { notify: () => undefined },
  };

  const defaultRequest = { remote: 'origin', review: directory };

  const run = (request: PublicationRequest = defaultRequest, projectTrusted = true) =>
    readPublicationEvidence({ exec: fake.exec, cwd: root, signal: undefined }, root, request, {
      ...config,
      location: { ...config.location, projectTrusted },
    });

  return { root, directory, mergeBase, fake, run };
};

export const readSavedFiles = async (root: string): Promise<[string, Buffer][]> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .filter((path) => !path.startsWith('.git/'))
    .toSorted();

  return Promise.all(paths.map(async (path) => [path, await readFile(join(root, path))]));
};

const outputHash = async (root: string, commandArguments: string[]): Promise<string> => {
  const { stdout } = await promisify(execFile)('git', commandArguments, {
    cwd: root,
    encoding: 'buffer',
  });

  return createHash('sha256').update(stdout).digest('hex');
};

export const saveFullCheck = async (
  root: string,
  passed: boolean,
  argv = ['pnpm', 'check'],
): Promise<string> => {
  const directory = join(root, '.tau', 'checks');
  const logPath = join(directory, '2026-01-01T00-00-00.log');

  await mkdir(directory, { recursive: true });
  await writeFile(join(root, '.git', 'info', 'exclude'), '.tau/\n', { flag: 'a' });
  await writeFile(logPath, 'compiling\nall done\n');

  const state = await readCheckState(root);

  await saveCheckRecord(logPath, { ...state, argv }, passed);

  return logPath;
};

export const gapsWithoutFullCheck = (evidence: PublicationEvidence): PublicationEvidence['gaps'] =>
  evidence.gaps.filter((gap) => gap.kind !== 'fullCheck');

export const saveCheck = async (
  root: string,
  mergeBase: string,
  body = 'tests passed\n',
): Promise<string> => {
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
