import { execFile } from 'node:child_process';
import {
  chmod,
  link as hardLink,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createTemporaryBareRoot, createTemporaryRepository } from '../tests/gitRepository.js';
import {
  checkTauDirectory,
  climbsOut,
  createFreshTauDirectory,
  ensureTauDirectory,
  findTauRoot,
  locateTauChild,
  rejectLinkedEntries,
  rejectLinkedFile,
  requireTauChild,
} from './tauDirectory.js';

const isIgnored = async (repository: string, path: string) => {
  try {
    await promisify(execFile)('git', ['check-ignore', '--quiet', path], { cwd: repository });

    return true;
  } catch {
    return false;
  }
};

const createTemporaryDirectory = async (
  registerCleanup: (cleanup: () => Promise<void>) => void,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-directory-'));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

const listTree = async (directory: string) =>
  (await readdir(directory, { recursive: true })).toSorted();

const symlinkCases = [
  { name: '.tau', link: '.tau' },
  { name: 'the target directory', link: '.tau/slices/me-479' },
  { name: 'a directory between .tau and the target', link: '.tau/slices' },
  { name: '.tau/.gitignore', link: '.tau/.gitignore' },
];

for (const { name, link } of symlinkCases) {
  it(`refuses when ${name} is a symlink and creates nothing`, async ({ onTestFinished }) => {
    const root = await createTemporaryDirectory(onTestFinished);
    const outside = await createTemporaryDirectory(onTestFinished);

    await mkdir(join(root, link, '..'), { recursive: true });
    await symlink(outside, join(root, link));

    const before = await listTree(root);

    await expect(ensureTauDirectory(root, 'slices/me-479')).rejects.toThrow(link);

    expect(await listTree(root)).toEqual(before);
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(join(root, link))).isSymbolicLink()).toBe(true);
  });
}

const hardLinkedIgnoreFile = async (registerCleanup: (cleanup: () => Promise<void>) => void) => {
  const root = await createTemporaryRepository(registerCleanup);
  const outside = await createTemporaryDirectory(registerCleanup);
  const outsideFile = join(outside, 'ignore');

  await writeFile(outsideFile, 'outside bytes\n');
  await mkdir(join(root, '.tau'));
  await hardLink(outsideFile, join(root, '.tau', '.gitignore'));

  return { root, outsideFile };
};

it('refuses a hard-linked .tau/.gitignore and leaves the linked file unchanged', async ({
  onTestFinished,
}) => {
  const { root, outsideFile } = await hardLinkedIgnoreFile(onTestFinished);
  const before = await listTree(root);

  await expect(ensureTauDirectory(root, 'slices/me-479')).rejects.toThrow('hard link');

  expect(await readFile(outsideFile, 'utf8')).toBe('outside bytes\n');
  expect(await listTree(root)).toEqual(before);
});

it('check refuses a hard-linked .tau/.gitignore', async ({ onTestFinished }) => {
  const { root, outsideFile } = await hardLinkedIgnoreFile(onTestFinished);

  await writeFile(outsideFile, '*\n');

  await expect(checkTauDirectory(root, 'slices')).rejects.toThrow('hard link');
});

it('prepares handovers in a bare repository root', async ({ onTestFinished }) => {
  const root = await createTemporaryBareRoot(onTestFinished);

  const directory = await ensureTauDirectory(root, 'handovers');

  expect(directory).toBe(join(root, '.tau', 'handovers'));
  expect((await lstat(directory)).isDirectory()).toBe(true);
  expect(await readFile(join(root, '.tau', '.gitignore'), 'utf8')).toMatch(/\*\n$/);

  const before = await listTree(root);
  const ignoreBefore = await readFile(join(root, '.tau', '.gitignore'), 'utf8');

  await expect(checkTauDirectory(root, 'handovers')).resolves.toBeUndefined();

  expect(await listTree(root)).toEqual(before);
  expect(await readFile(join(root, '.tau', '.gitignore'), 'utf8')).toBe(ignoreBefore);
});

it.for([
  { content: undefined, error: /final \* rule/ },
  { content: '*\n!handovers/message.md\n', error: /exception follows/ },
])(
  'checks a bare root with ignore content $content without writes',
  async ({ content, error }, { onTestFinished }) => {
    const root = await createTemporaryBareRoot(onTestFinished);
    const ignoreFile = join(root, '.tau', '.gitignore');

    await mkdir(join(root, '.tau'));

    if (content !== undefined) {
      await writeFile(ignoreFile, content);
    }

    const before = await listTree(root);

    await expect(checkTauDirectory(root, 'handovers')).rejects.toThrow(error);

    const ignoreAfter = await readFile(ignoreFile, 'utf8').catch(() => undefined);

    expect(await listTree(root)).toEqual(before);
    expect(ignoreAfter).toBe(content);
  },
);

it('creates the directory and makes Git ignore everything in .tau', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  const directory = await ensureTauDirectory(repository, 'slices/me-479');

  expect((await lstat(directory)).isDirectory()).toBe(true);
  expect(directory).toBe(join(repository, '.tau/slices/me-479'));
  expect(await isIgnored(repository, '.tau/slices/me-479/plan.md')).toBe(true);
  expect(await isIgnored(repository, '.tau/.gitignore')).toBe(true);
});

it('keeps existing ignore rules and adds the ignore rule once', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await mkdir(join(repository, '.tau'));
  await writeFile(join(repository, '.tau/.gitignore'), 'state.json');

  await ensureTauDirectory(repository, 'slices/me-479');
  await ensureTauDirectory(repository, 'pr');

  expect(await readFile(join(repository, '.tau/.gitignore'), 'utf8')).toBe('state.json\n*\n');
});

it('creates a new ignored directory on each fresh call', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  const first = await createFreshTauDirectory(repository, 'workers', 'review-');
  const second = await createFreshTauDirectory(repository, 'workers', 'review-');

  expect(first).not.toBe(second);
  expect(dirname(first)).toBe(join(repository, '.tau/workers'));
  expect(dirname(second)).toBe(join(repository, '.tau/workers'));
  expect(await isIgnored(repository, join(first, 'input.md'))).toBe(true);
});

it.for(['', '../outside', 'slices/../..', '/tmp/outside', 'slices//me-479'])(
  'refuses the path %j and creates nothing',
  async (path, { onTestFinished }) => {
    const root = await createTemporaryDirectory(onTestFinished);

    await expect(ensureTauDirectory(root, path)).rejects.toBeInstanceOf(Error);

    expect(await readdir(root)).toEqual([]);
  },
);

it.for([String.raw`..\outside`, String.raw`slices\me-479`])(
  'refuses the path %j with a backslash in a repository and creates nothing',
  async (path, { onTestFinished }) => {
    const repository = await createTemporaryRepository(onTestFinished);
    const before = await readdir(repository);

    await expect(ensureTauDirectory(repository, path)).rejects.toThrow(path);

    expect(await readdir(repository)).toEqual(before);
  },
);

it.for(['../review-', String.raw`..\review-`])(
  'refuses the fresh directory prefix %j with a separator and creates nothing',
  async (prefix, { onTestFinished }) => {
    const root = await createTemporaryDirectory(onTestFinished);

    await expect(createFreshTauDirectory(root, 'workers', prefix)).rejects.toThrow(prefix);

    expect(await readdir(root)).toEqual([]);
  },
);

it('refuses a tracked .tau/.gitignore before it changes anything', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const ignoreFile = join(repository, '.tau/.gitignore');

  await mkdir(join(repository, '.tau'));
  await writeFile(ignoreFile, 'state.json\n');
  await promisify(execFile)('git', ['add', '--force', ignoreFile], { cwd: repository });

  await expect(ensureTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    'Git tracks files in .tau/.gitignore',
  );

  expect(await readFile(ignoreFile, 'utf8')).toBe('state.json\n');
  expect(await readdir(join(repository, '.tau'))).toEqual(['.gitignore']);
});

it('overrides a .tau/.gitignore exception for a file in the target', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await mkdir(join(repository, '.tau'));

  await writeFile(
    join(repository, '.tau/.gitignore'),
    '*\n!slices/\n!slices/me-479/\n!slices/me-479/plan.json\n',
  );

  await ensureTauDirectory(repository, 'slices/me-479');

  expect(await isIgnored(repository, '.tau/slices/me-479/plan.json')).toBe(true);
});

it('check refuses an exception added after the ignore rule and changes nothing', async ({
  onTestFinished,
}) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const ignoreFile = join(repository, '.tau/.gitignore');

  await ensureTauDirectory(repository, 'slices/me-479');
  await writeFile(ignoreFile, '!slices/me-479/plan.json\n', { flag: 'a' });

  const before = await readFile(ignoreFile, 'utf8');

  await expect(checkTauDirectory(repository, 'slices/me-479')).rejects.toThrow('.tau/.gitignore');

  expect(await readFile(ignoreFile, 'utf8')).toBe(before);
});

it('check accepts a directory that the root .gitignore ignores without .tau/.gitignore', async ({
  onTestFinished,
}) => {
  const repository = await createTemporaryRepository(onTestFinished);

  await writeFile(join(repository, '.gitignore'), '.tau/\n');
  await mkdir(join(repository, '.tau/slices/me-479'), { recursive: true });

  await expect(checkTauDirectory(repository, 'slices/me-479')).resolves.toBeUndefined();
  expect(await readdir(join(repository, '.tau'))).toEqual(['slices']);
});

it('refuses when Git tracks a file in the target', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const tracked = join(repository, '.tau/slices/me-479/file');

  await mkdir(dirname(tracked), { recursive: true });
  await writeFile(tracked, 'tracked\n');
  await promisify(execFile)('git', ['add', '--force', tracked], { cwd: repository });

  await expect(ensureTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    '.tau/slices/me-479',
  );
});

it('refuses a tracked file in the target before it creates .tau/.gitignore', async ({
  onTestFinished,
}) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const tracked = join(repository, '.tau/slices/me-479/plan.json');

  await mkdir(dirname(tracked), { recursive: true });
  await writeFile(tracked, '{}\n');
  await promisify(execFile)('git', ['add', '--force', tracked], { cwd: repository });

  await expect(ensureTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    'Git tracks files in .tau/slices/me-479',
  );

  expect(await readdir(join(repository, '.tau'))).toEqual(['slices']);
});

it('refuses when Git tracks a file in an ignored target', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const tracked = join(repository, '.tau/slices/me-479/plan.json');

  await ensureTauDirectory(repository, 'slices/me-479');
  await writeFile(tracked, '{}\n');
  await promisify(execFile)('git', ['add', '--force', tracked], { cwd: repository });

  await expect(checkTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    '.tau/slices/me-479',
  );
});

it.for(['..', '.', ''])(
  'refuses the fresh directory prefix %j and creates nothing',
  async (prefix, { onTestFinished }) => {
    const root = await createTemporaryDirectory(onTestFinished);

    await expect(createFreshTauDirectory(root, 'workers', prefix)).rejects.toBeInstanceOf(Error);

    expect(await readdir(root)).toEqual([]);
  },
);

it.each([
  { directory: '.tau/pr/run-x', prefix: 'run-', place: { kind: 'child', name: 'run-x' } },
  { directory: '.tau/pr/..run-x', prefix: '..run-', place: { kind: 'child', name: '..run-x' } },
  { directory: '.tau/pr/..run-x', prefix: 'run-', place: { kind: 'unnamed' } },
  { directory: '.tau/pr/run-', prefix: 'run-', place: { kind: 'unnamed' } },
  { directory: '.tau/pr/run-x/body', prefix: 'run-', place: { kind: 'nested' } },
  { directory: '.tau/pr/..', prefix: 'run-', place: { kind: 'outside' } },
  { directory: '.tau/pr/../x', prefix: 'run-', place: { kind: 'outside' } },
  { directory: String.raw`.tau/pr/..\x`, prefix: 'run-', place: { kind: 'outside' } },
  { directory: '/elsewhere/run-x', prefix: 'run-', place: { kind: 'outside' } },
])('places $directory with prefix $prefix as $place.kind', ({ directory, prefix, place }) => {
  expect(locateTauChild('/repository', 'pr', prefix, directory)).toEqual(place);
});

it.for(['', '.', '..', 'a/..', '../x', 'a//b', 'a/./b'])(
  'refuses the Tau directory path %j in a Git repository before it writes',
  async (path, { onTestFinished }) => {
    const repository = await createTemporaryRepository(onTestFinished);
    const before = await listTree(repository);

    await expect(ensureTauDirectory(repository, path)).rejects.toThrow('below .tau');
    await expect(checkTauDirectory(repository, path)).rejects.toThrow('below .tau');

    expect(await listTree(repository)).toEqual(before);
  },
);

it.for(['', '.', '..'])(
  'refuses the fresh directory prefix %j in a Git repository before it writes',
  async (prefix, { onTestFinished }) => {
    const repository = await createTemporaryRepository(onTestFinished);
    const before = await listTree(repository);

    await expect(createFreshTauDirectory(repository, 'workers', prefix)).rejects.toThrow(
      'must be a name',
    );

    expect(await listTree(repository)).toEqual(before);
  },
);

it('check refuses a target that Git does not ignore', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  await mkdir(join(repository, '.tau/slices'), { recursive: true });

  await expect(checkTauDirectory(repository, 'slices')).rejects.toThrow(
    'Git does not ignore files in .tau/slices',
  );
});

const bareRootWithGitFile = async (
  registerCleanup: (cleanup: () => Promise<void>) => void,
  content: string | undefined,
) => {
  const root = await createTemporaryBareRoot(registerCleanup);

  if (content === undefined) {
    await rm(join(root, '.git'));
  } else {
    await writeFile(join(root, '.git'), content);
  }

  return { root, bare: join(root, '.bare') };
};

it.for([
  { name: 'a final newline', content: 'gitdir: .bare\n' },
  { name: 'CRLF line ends', content: 'gitdir: .bare\r\n' },
  { name: 'no final newline', content: 'gitdir: .bare' },
  { name: 'trailing spaces', content: 'gitdir: .bare  \n' },
])('finds the bare root from a .git file with $name', async ({ content }, { onTestFinished }) => {
  const { root, bare } = await bareRootWithGitFile(onTestFinished, content);

  await expect(findTauRoot(bare, 'handover')).resolves.toBe(await realpath(root));
});

it.for([
  { name: 'extra lines', content: 'gitdir: .bare\nextra\n' },
  { name: 'text before gitdir', content: 'see gitdir: .bare\n' },
  { name: 'a gitdir that points elsewhere', content: 'gitdir: .other\n' },
  { name: 'a gitdir that does not exist', content: 'gitdir: .missing\n' },
  { name: 'no .git file', content: undefined },
])(
  'falls back to the bare Git directory for a .git file with $name',
  async ({ content }, { onTestFinished }) => {
    const { root, bare } = await bareRootWithGitFile(onTestFinished, content);

    if (content === 'gitdir: .other\n') {
      await mkdir(join(root, '.other'));
    }

    await expect(findTauRoot(bare, 'handover')).resolves.toBe(await realpath(bare));
  },
);

it('throws when the .git file points through a file', async ({ onTestFinished }) => {
  const { bare } = await bareRootWithGitFile(onTestFinished, 'gitdir: .bare/HEAD/x\n');

  await expect(findTauRoot(bare, 'handover')).rejects.toMatchObject({ code: 'ENOTDIR' });
});

it.for([
  { name: 'a comment line', content: '*\n# keep this\n' },
  { name: 'a whitespace-only line', content: '*\n   \n' },
])('adds no second ignore rule after $name', async ({ content }, { onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  await mkdir(join(repository, '.tau'));
  await writeFile(join(repository, '.tau/.gitignore'), content);
  await ensureTauDirectory(repository, 'slices');

  expect(await readFile(join(repository, '.tau/.gitignore'), 'utf8')).toBe(content);
});

it.skipIf(process.getuid?.() === 0)(
  'refuses an unreadable .tau/.gitignore and leaves it unchanged',
  async ({ onTestFinished }) => {
    const repository = await createTemporaryRepository(onTestFinished);
    const ignoreFile = join(repository, '.tau/.gitignore');

    await mkdir(join(repository, '.tau'));
    await writeFile(ignoreFile, 'state.json\n');
    await chmod(ignoreFile, 0o200);
    onTestFinished(() => chmod(ignoreFile, 0o600));

    await expect(ensureTauDirectory(repository, 'slices')).rejects.toMatchObject({
      code: 'EACCES',
    });

    await chmod(ignoreFile, 0o600);

    expect(await readFile(ignoreFile, 'utf8')).toBe('state.json\n');
  },
);

it.each([
  { directory: '.tau/pr/..run-x', prefix: '', name: '..run-x' },
  { directory: '.tau/pr/run-x', prefix: 'run-', name: 'run-x' },
])('accepts $directory with prefix "$prefix" as the Tau child $name', (row) => {
  expect(
    requireTauChild('/repository', 'pr', row.prefix, row.directory, 'The body directory'),
  ).toBe(row.name);
});

it.each([
  {
    directory: '.tau/pr/../x',
    prefix: '',
    error: 'The body directory must be in .tau/pr, not .tau/pr/../x.',
  },
  {
    directory: '/elsewhere/x',
    prefix: '',
    error: 'The body directory must be in .tau/pr, not /elsewhere/x.',
  },
  {
    directory: '.tau/pr/a/b',
    prefix: '',
    error: 'The body directory must sit directly in .tau/pr, not .tau/pr/a/b.',
  },
  {
    directory: '.tau/pr',
    prefix: '',
    error: 'The body directory must name a directory in .tau/pr, not .tau/pr.',
  },
  {
    directory: '.tau/pr/other',
    prefix: 'run-',
    error: 'The body directory must be named run-* by prepare, not .tau/pr/other.',
  },
])('refuses $directory with prefix "$prefix" as a Tau child', (row) => {
  expect(() =>
    requireTauChild('/repository', 'pr', row.prefix, row.directory, 'The body directory'),
  ).toThrow(row.error);
});

it.each([
  { path: '..', climbs: true },
  { path: '../a', climbs: true },
  { path: '/etc', climbs: true },
  { path: String.raw`..\x`, climbs: true },
  { path: String.raw`a\b/../..`, climbs: true },
  { path: '..rules.md', climbs: false },
  { path: '..run-x', climbs: false },
  { path: 'a/../b', climbs: false },
  { path: '', climbs: false },
])('says whether the relative path $path climbs out', ({ path, climbs }) => {
  expect(climbsOut(path)).toBe(climbs);
});

const makeLinkedFileDirectory = () => mkdtemp(join(tmpdir(), 'tau-linked-file-'));

const acceptedFileCases = [
  { name: 'a missing path', setup: async () => undefined },
  { name: 'a plain file', setup: (path: string) => writeFile(path, 'text\n') },
  { name: 'a directory', setup: (path: string) => mkdir(path) },
];

const refusedFileCases = [
  {
    name: 'a symlink',
    kind: 'a symlink',
    setup: async (path: string) => {
      const target = join(await makeLinkedFileDirectory(), 'target.md');

      await writeFile(target, 'text\n');
      await symlink(target, path);
    },
  },
  {
    name: 'a hard-linked file',
    kind: 'a file with another hard link',
    setup: async (path: string) => {
      const other = join(await makeLinkedFileDirectory(), 'other.md');

      await writeFile(other, 'text\n');
      await hardLink(other, path);
    },
  },
  {
    name: 'a FIFO',
    kind: 'a file that is not a regular file',
    setup: async (path: string) => {
      await promisify(execFile)('mkfifo', [path]);
    },
  },
];

for (const verb of ['read', 'write'] as const) {
  for (const { name, setup } of acceptedFileCases) {
    it(`rejectLinkedFile for ${verb} accepts ${name}`, async () => {
      const path = join(await makeLinkedFileDirectory(), 'file.md');

      await setup(path);

      await expect(rejectLinkedFile(path, verb)).resolves.toBeUndefined();
    });
  }

  for (const { name, kind, setup } of refusedFileCases) {
    it(`rejectLinkedFile for ${verb} refuses ${name}`, async () => {
      const path = join(await makeLinkedFileDirectory(), 'file.md');

      await setup(path);

      await expect(rejectLinkedFile(path, verb)).rejects.toThrow(
        `Refusing to ${verb} through ${kind}: ${path}`,
      );
    });
  }
}

it('rejectLinkedFile rethrows an lstat error other than a missing file', async () => {
  const parent = join(await makeLinkedFileDirectory(), 'plain.md');

  await writeFile(parent, 'text\n');

  await expect(rejectLinkedFile(join(parent, 'file.md'), 'read')).rejects.toThrow('ENOTDIR');
});

it('rejectLinkedEntries accepts a directory with a subdirectory and a plain file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-linked-entries-'));

  await mkdir(join(directory, 'notes'));
  await writeFile(join(directory, 'slice-1.md'), 'text\n');

  await expect(rejectLinkedEntries(directory)).resolves.toBeUndefined();
});

it('rejectLinkedEntries refuses an entry with another hard link and leaves the other file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-linked-entries-'));
  const outside = join(await mkdtemp(join(tmpdir(), 'tau-linked-outside-')), 'secret.md');

  await writeFile(outside, 'Not for Linear.\n');
  await hardLink(outside, join(directory, 'slice-1.md'));

  await expect(rejectLinkedEntries(directory)).rejects.toThrow(/hard link: .*slice-1\.md$/);
  expect(await readFile(outside, 'utf8')).toBe('Not for Linear.\n');
});

it('rejectLinkedEntries refuses a symlinked entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-linked-entries-'));

  await symlink(directory, join(directory, 'loop'));

  await expect(rejectLinkedEntries(directory)).rejects.toThrow(/symlink: .*loop$/);
});
