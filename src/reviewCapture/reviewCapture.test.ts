import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { captureTarget, pinTarget } from './reviewCapture.js';

const git = async (root: string, commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd: root });

  return stdout;
};

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, ['add', 'tracked.txt']);
  await git(root, ['commit', '--quiet', '-m', 'first']);

  return root;
};

const head = async (root: string) => (await git(root, ['rev-parse', 'HEAD'])).trim();

const isRoot = process.getuid?.() === 0;

const hashObject = async (bytes: Buffer) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-capture-hash-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const file = join(directory, 'capture.diff');
  await writeFile(file, bytes);

  return (await git(directory, ['hash-object', file])).trim();
};

it('captures a tracked change and an untracked file with the hash Git gives the bytes', async () => {
  const root = await committedRepository();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(root, 'untracked.txt'), 'new\n');

  const target = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });
  const capture = await captureTarget(root, target);
  const text = capture.bytes.toString('utf8');

  expect(capture.errors).toEqual([]);
  expect(capture.paths).toEqual(['tracked.txt', 'untracked.txt']);
  expect(text).toContain('+two');
  expect(text).toContain('+new');
  expect(capture.hash).toBe(await hashObject(capture.bytes));
});

it('lists both paths of a renamed file', async () => {
  const root = await committedRepository();

  await git(root, ['mv', 'tracked.txt', 'renamed.txt']);

  const target = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });
  const capture = await captureTarget(root, target);

  expect(capture.errors).toEqual([]);
  expect(capture.paths).toEqual(['renamed.txt', 'tracked.txt']);
});

const nestedRepository = async (root: string) => {
  const module = join(root, 'module');

  await mkdir(module);
  await git(module, ['init', '--quiet', '--initial-branch=main']);
  await writeFile(join(module, 'inner.txt'), 'inner\n');
  await git(module, ['add', 'inner.txt']);
  await git(module, ['commit', '--quiet', '-m', 'inner']);
};

it('reports a committed Git link as a gap and keeps the other named files', async () => {
  const root = await committedRepository();

  await nestedRepository(root);
  await git(root, ['add', 'module']);
  await git(root, ['commit', '--quiet', '-m', 'module']);

  const target = await pinTarget(root, { kind: 'files', paths: ['module', 'tracked.txt'] });
  const capture = await captureTarget(root, target);

  expect(capture.errors).toEqual([]);
  expect(capture.paths).toEqual(['tracked.txt']);
  expect(capture.gaps).toEqual([{ kind: 'submodule', path: 'module' }]);
  expect(capture.bytes.toString('utf8')).toContain('+one');
});

it('keeps the commit change of a changed Git link in the diff', async () => {
  const root = await committedRepository();

  await nestedRepository(root);
  await git(root, ['add', 'module']);
  await git(root, ['commit', '--quiet', '-m', 'module']);
  await writeFile(join(root, 'module', 'inner.txt'), 'changed\n');
  await git(join(root, 'module'), ['commit', '--quiet', '-am', 'inner change']);

  const target = await pinTarget(root, { kind: 'files', paths: ['module'] });
  const capture = await captureTarget(root, target);

  expect(capture.errors).toEqual([]);
  expect(capture.paths).toEqual(['module']);
  expect(capture.gaps).toEqual([{ kind: 'submodule', path: 'module' }]);
  expect(capture.bytes.toString('utf8')).toContain('+Subproject commit');
});

it('reports an untracked nested repository as a gap', async () => {
  const root = await committedRepository();

  await nestedRepository(root);
  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const target = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });
  const capture = await captureTarget(root, target);

  expect(capture.errors).toEqual([]);
  expect(capture.paths).toEqual(['tracked.txt']);
  expect(capture.gaps).toEqual([{ kind: 'submodule', path: 'module' }]);
});

it('reports a binary file as a gap', async () => {
  const root = await committedRepository();

  await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]));

  const capture = await captureTarget(
    root,
    await pinTarget(root, { kind: 'workingTree', base: 'HEAD' }),
  );

  expect(capture.errors).toEqual([]);
  expect(capture.gaps).toEqual([{ kind: 'binary', path: 'image.bin' }]);
});

it('reports a named binary file once', async () => {
  const root = await committedRepository();

  await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]));
  await git(root, ['add', 'image.bin']);
  await git(root, ['commit', '--quiet', '-m', 'image']);
  await writeFile(join(root, 'image.bin'), Buffer.from([0, 3, 4, 0, 255]));

  const target = await pinTarget(root, { kind: 'files', paths: ['image.bin'] });
  const capture = await captureTarget(root, target);

  expect(capture.gaps).toEqual([{ kind: 'binary', path: 'image.bin' }]);
});

it.skipIf(isRoot)(
  'reports an unreadable file as a gap and still captures the rest (skipped as root, who can read every file)',
  async () => {
    const root = await committedRepository();

    await writeFile(join(root, 'tracked.txt'), 'two\n');
    await writeFile(join(root, 'secret.txt'), 'hidden\n');
    await chmod(join(root, 'secret.txt'), 0o000);

    const target = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });
    const capture = await captureTarget(root, target);

    expect(capture.errors).toEqual([]);
    expect(capture.gaps).toEqual([{ kind: 'unreadable', path: 'secret.txt' }]);
    expect(capture.paths).toEqual(['tracked.txt']);
  },
);

it('captures only the diff between the two ends of a commit range', async () => {
  const root = await committedRepository();
  const from = await head(root);

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await git(root, ['commit', '--quiet', '-am', 'second']);
  await writeFile(join(root, 'tracked.txt'), 'uncommitted\n');
  await writeFile(join(root, 'untracked.txt'), 'new\n');

  const target = await pinTarget(root, { kind: 'range', from: 'HEAD~1', to: 'HEAD' });
  const capture = await captureTarget(root, target);
  const text = capture.bytes.toString('utf8');

  expect(target).toEqual({ kind: 'range', from, to: await head(root) });
  expect(capture.paths).toEqual(['tracked.txt']);
  expect(text).toContain('+two');
  expect(text).not.toContain('uncommitted');
});

it('captures a root commit in full and refuses a commit with a parent', async () => {
  const root = await committedRepository();
  const rootCommit = await head(root);

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await git(root, ['commit', '--quiet', '-am', 'second']);

  const target = await pinTarget(root, { kind: 'rootCommit', commit: rootCommit });
  const capture = await captureTarget(root, target);

  expect(capture.errors).toEqual([]);
  expect(capture.paths).toEqual(['tracked.txt']);
  expect(capture.bytes.toString('utf8')).toContain('+one');

  await expect(pinTarget(root, { kind: 'rootCommit', commit: 'HEAD' })).rejects.toThrow(rootCommit);
});

it('captures named files in full, unchanged ones included, and reports a path that lists nothing', async () => {
  const root = await committedRepository();

  await writeFile(join(root, 'unchanged.txt'), 'steady\n');
  await git(root, ['add', 'unchanged.txt']);
  await git(root, ['commit', '--quiet', '-m', 'second']);
  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(root, 'other.txt'), 'not named\n');

  const target = await pinTarget(root, {
    kind: 'files',
    paths: ['unchanged.txt', 'tracked.txt', 'missing.txt'],
  });

  const capture = await captureTarget(root, target);
  const text = capture.bytes.toString('utf8');

  expect(capture.errors).toEqual([]);
  expect(capture.paths).toEqual(['tracked.txt', 'unchanged.txt']);
  expect(capture.gaps).toEqual([{ kind: 'unmatched', path: 'missing.txt' }]);
  expect(text).toContain('+steady');
  expect(text).toContain('-one');
  expect(text).not.toContain('not named');
});

it('leaves an excluded path out of the capture and reports it as a gap', async () => {
  const root = await committedRepository();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(root, 'generated.txt'), 'generated\n');

  const target = await pinTarget(root, {
    kind: 'workingTree',
    base: 'HEAD',
    exclude: ['generated.txt'],
  });

  const capture = await captureTarget(root, target);

  expect(capture.paths).toEqual(['tracked.txt']);
  expect(capture.bytes.toString('utf8')).not.toContain('generated');
  expect(capture.gaps).toEqual([{ kind: 'excluded', path: 'generated.txt' }]);
});

it('leaves .git/index, the Git objects, and the refs unchanged, with a caching textconv driver', async () => {
  const root = await committedRepository();

  await writeFile(join(root, '.gitattributes'), 'tracked.txt diff=cached\n');
  await git(root, ['add', '.gitattributes']);
  await git(root, ['commit', '--quiet', '-m', 'attributes']);
  await git(root, ['config', 'diff.cached.textconv', 'cat']);
  await git(root, ['config', 'diff.cached.cachetextconv', 'true']);
  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(root, 'untracked.txt'), 'new\n');
  // A newer modification time on unchanged content makes git diff refresh the cached file
  // metadata in .git/index unless the capture turns that off.
  await utimes(join(root, '.gitattributes'), new Date(), new Date(Date.now() + 60_000));

  const indexBefore = await readFile(join(root, '.git', 'index'));
  const objectsBefore = await git(root, ['count-objects', '-v']);
  const refsBefore = await git(root, ['for-each-ref']);

  const capture = await captureTarget(
    root,
    await pinTarget(root, { kind: 'workingTree', base: 'HEAD' }),
  );

  expect(capture.errors).toEqual([]);
  expect(await readFile(join(root, '.git', 'index'))).toEqual(indexBefore);
  expect(await git(root, ['count-objects', '-v'])).toBe(objectsBefore);
  expect(await git(root, ['for-each-ref'])).toBe(refsBefore);
});

it.skipIf(isRoot)(
  'reports an unreadable tracked file as a gap and keeps the readable changes (skipped as root, who can read every file)',
  async () => {
    const root = await committedRepository();

    await writeFile(join(root, 'other.txt'), 'first\n');
    await git(root, ['add', 'other.txt']);
    await git(root, ['commit', '--quiet', '-m', 'other']);
    await writeFile(join(root, 'other.txt'), 'second\n');
    await writeFile(join(root, 'tracked.txt'), 'changed\n');
    await chmod(join(root, 'tracked.txt'), 0o000);
    onTestFinished(() => chmod(join(root, 'tracked.txt'), 0o644));

    const target = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });
    const capture = await captureTarget(root, target);

    expect(capture.errors).toEqual([]);
    expect(capture.paths).toEqual(['other.txt']);
    expect(capture.gaps).toEqual([{ kind: 'unreadable', path: 'tracked.txt' }]);
    expect(capture.bytes.toString('utf8')).toContain('+second');
  },
);

it('refuses a revision that starts with a dash', async () => {
  const root = await committedRepository();

  await expect(
    pinTarget(root, { kind: 'workingTree', base: `--output=${join(root, 'written.diff')}` }),
  ).rejects.toThrow('--output');

  expect(await git(root, ['status', '--porcelain'])).toBe('');
});

it('refuses a revision Git cannot resolve', async () => {
  const root = await committedRepository();

  await expect(pinTarget(root, { kind: 'workingTree', base: 'no-such-branch' })).rejects.toThrow(
    'no-such-branch',
  );
});
