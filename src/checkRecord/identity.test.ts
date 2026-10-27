import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';

import { installCommandShim } from '../../tests/commandShimFake.js';
import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { readCheckIdentity } from './identity.js';
import { decideReuse } from './reuseDecision.js';
import type { CheckIdentity, SavedLog } from './reuseDecision.js';

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return { ...actual, copyFile: vi.fn<typeof actual.copyFile>(actual.copyFile) };
});

const argv = ['pnpm', 'check'];

const committedRepository = async (registerCleanup: RegisterCleanup): Promise<string> => {
  const root = await createTemporaryRepository(registerCleanup);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'one');
  await writeFile(join(root, 'ignored.txt'), 'one\n');

  return root;
};

const passingLog = (identity: CheckIdentity): SavedLog => {
  if (identity.tree === null) {
    throw new Error('A state without a tree has no record.');
  }

  return {
    logPath: 'run.log',
    read: {
      status: 'valid',
      record: { version: 3, tree: identity.tree, argv: identity.argv, passed: true },
    },
    logExists: true,
  };
};

it('reuses a passing record after a commit of the same content and an amend of its message', async () => {
  const root = await committedRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(root, 'new.txt'), 'new\n');

  const saved = [passingLog(await readCheckIdentity(root, argv))];

  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'two');

  expect(decideReuse(await readCheckIdentity(root, argv), saved)).toEqual({
    status: 'reuse',
    logPath: 'run.log',
  });

  await git(root, 'commit', '--quiet', '--amend', '-m', 'other');

  expect(decideReuse(await readCheckIdentity(root, argv), saved)).toEqual({
    status: 'reuse',
    logPath: 'run.log',
  });
});

it.each([
  {
    name: 'a change to a tracked file',
    change: (root: string) => writeFile(join(root, 'tracked.txt'), 'two\n'),
  },
  {
    name: 'a new untracked file',
    change: (root: string) => writeFile(join(root, 'new.txt'), 'new\n'),
  },
  {
    name: 'a file mode change',
    change: (root: string) => chmod(join(root, 'tracked.txt'), 0o755),
  },
  {
    name: 'a mode change with filemode off',
    change: async (root: string) => {
      await git(root, 'config', 'core.filemode', 'false');
      await chmod(join(root, 'tracked.txt'), 0o755);
    },
  },
])('gives a new identity for $name', async ({ change }) => {
  const root = await committedRepository(onTestFinished);
  const before = await readCheckIdentity(root, argv);

  await change(root);

  const after = await readCheckIdentity(root, argv);

  expect(after.tree).not.toBeNull();
  expect(after.tree).not.toBe(before.tree);
  expect(decideReuse(after, [passingLog(before)])).toEqual({ status: 'run' });
});

it('keeps the identity when only an ignored file changes', async () => {
  const root = await committedRepository(onTestFinished);
  const before = await readCheckIdentity(root, argv);

  await writeFile(join(root, 'ignored.txt'), 'two\n');

  expect(await readCheckIdentity(root, argv)).toEqual(before);
});

it('gives no tree for a dirty submodule, so the check runs', async () => {
  const root = await committedRepository(onTestFinished);
  const submodule = join(root, 'module');

  await mkdir(submodule);
  await git(submodule, 'init', '--quiet', '--initial-branch=main');
  await git(submodule, 'commit', '--quiet', '--allow-empty', '-m', 'one');
  await git(root, 'add', 'module');
  await git(root, 'commit', '--quiet', '-m', 'module');

  const clean = await readCheckIdentity(root, argv);

  await writeFile(join(submodule, 'untracked.txt'), 'inner\n');

  const dirty = await readCheckIdentity(root, argv);

  expect(dirty.tree).toBeNull();
  expect(decideReuse(dirty, [passingLog(clean)])).toEqual({ status: 'run' });
});

it('leaves the real index unchanged when it reads an untracked file', async () => {
  const root = await committedRepository(onTestFinished);

  await writeFile(join(root, 'new.txt'), 'new\n');
  await readCheckIdentity(root, argv);

  expect(await git(root, 'diff', '--cached', '--name-only')).toBe('');

  expect((await promisify(execFile)('git', ['status', '--porcelain'], { cwd: root })).stdout).toBe(
    '?? new.txt\n',
  );
});

it('gives a new identity when an untracked text file changes from LF to CRLF under an eol attribute', async () => {
  const root = await committedRepository(onTestFinished);

  await writeFile(join(root, '.gitattributes'), '*.txt text eol=lf\n');
  await writeFile(join(root, 'new.txt'), 'a\n');

  const before = await readCheckIdentity(root, argv);

  await writeFile(join(root, 'new.txt'), 'a\r\n');

  const after = await readCheckIdentity(root, argv);

  expect(after.tree).not.toBeNull();
  expect(after.tree).not.toBe(before.tree);
  expect(decideReuse(after, [passingLog(before)])).toEqual({ status: 'run' });
});

it('gives no tree when info/attributes sets an attribute, so the check runs', async () => {
  const root = await committedRepository(onTestFinished);

  await writeFile(join(root, '.git', 'info', 'attributes'), '*.txt text eol=lf\n');

  expect((await readCheckIdentity(root, argv)).tree).toBeNull();
});

it('gives a tree for a repository with no index file, and creates none', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'new.txt'), 'new\n');

  expect((await readCheckIdentity(root, argv)).tree).not.toBeNull();
  await expect(stat(join(root, '.git', 'index'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects with a copy error that is not a missing index, and leaves the real index as it was', async () => {
  const root = await committedRepository(onTestFinished);
  const indexPath = join(root, '.git', 'index');
  const indexBefore = await readFile(indexPath);
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });

  vi.mocked(copyFile).mockRejectedValueOnce(denied);

  await expect(readCheckIdentity(root, argv)).rejects.toBe(denied);
  expect(await readFile(indexPath)).toEqual(indexBefore);
});

it('fails with the Git error when Git is killed', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [{ match: ' rev-parse ', script: 'kill -9 $$' }],
  });

  await expect(readCheckIdentity(root, argv)).rejects.toThrow('git rev-parse');
});

it('gives no tree when Git is older than 2.41, so the check runs', async () => {
  const root = await committedRepository(onTestFinished);

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [{ match: ' version ', script: "echo 'git version 2.40.1'" }],
  });

  const identity = await readCheckIdentity(root, argv);

  expect(identity.tree).toBeNull();
  expect(decideReuse(identity, [])).toEqual({ status: 'run' });
});

it.each([
  { version: 'git version 1.99.0', hasTree: false },
  { version: 'git version 2.41.0', hasTree: true },
  { version: 'git version 3.0.0', hasTree: true },
  { version: 'git version unknown', hasTree: false },
])('reads a tree only from Git 2.41 on: $version', async ({ version, hasTree }) => {
  const root = await committedRepository(onTestFinished);

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [{ match: ' version ', script: `echo '${version}'` }],
  });

  expect((await readCheckIdentity(root, argv)).tree !== null).toBe(hasTree);
});
