import { execFile } from 'node:child_process';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository, initializeRepository } from '../../../tests/gitRepository.js';
import { writeStommeProject } from '../../../tests/stommeProjectHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { resolveStommeGuides } from './stommeGuides.js';

const swap = vi.hoisted(() => ({
  afterStat: undefined as undefined | ((path: string) => Promise<void>),
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    default: actual,
    // The cast keeps the overloads of `stat` that the hook does not change.
    stat: (async (path: string) => {
      const result = await actual.stat(path);
      await swap.afterStat?.(path);

      return result;
    }) as typeof actual.stat,
  };
});

const sha256Hex = /^[\da-f]{64}$/;

const readTree = async (directory: string): Promise<Record<string, string>> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const tree: Record<string, string> = {};

  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const file = join(entry.parentPath, entry.name);
    tree[file] = await readFile(file, 'utf8');
  }

  return tree;
};

const reasonOf = (snapshot: { kind: string; reason?: string }): string => snapshot.reason ?? '';

// A reader that opens a named pipe waits for a writer. Opening it for writing lets a stuck read end.
const makePipe = async (path: string, onTestFinished: (cleanup: () => Promise<void>) => void) => {
  await promisify(execFile)('mkfifo', [path]);

  onTestFinished(async () => {
    const handle = await open(path, 'r+');
    await handle.close();
  });
};

const digestOf = async (cwd: string): Promise<string> => {
  const snapshot = await resolveStommeGuides(cwd);

  expect(snapshot.kind).not.toBe('broken');

  return snapshot.kind === 'broken' ? snapshot.reason : snapshot.digest;
};

it('finds stomme.toml from a subfolder of the repository', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(repository, { language: 'rust' });
  const subfolder = join(repository, 'src', 'deep');
  await mkdir(subfolder, { recursive: true });

  const snapshot = await resolveStommeGuides(subfolder);

  expect(snapshot).toMatchObject({ kind: 'project', root: repository, language: 'rust' });
});

it('ignores a stomme.toml above the repository top level', async ({ onTestFinished }) => {
  const outer = temporaryDirectory(onTestFinished, 'tau-stomme-outer-');
  await writeStommeProject(outer, { language: 'rust' });
  const repository = join(outer, 'repository');
  await mkdir(repository);
  await initializeRepository(repository);

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot.kind).toBe('bundle');
});

it('reads only the working directory outside Git', async ({ onTestFinished }) => {
  const outer = temporaryDirectory(onTestFinished, 'tau-stomme-outer-');
  await writeStommeProject(outer, { language: 'rust' });
  const subfolder = join(outer, 'subfolder');
  await mkdir(subfolder);

  const fromSubfolder = await resolveStommeGuides(subfolder);
  const fromRoot = await resolveStommeGuides(outer);

  expect(fromSubfolder.kind).toBe('bundle');
  expect(fromRoot).toMatchObject({ kind: 'project', root: outer });
});

it('returns the bundle without stomme.toml', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot).toMatchObject({ kind: 'bundle', version: '0.2.0' });
  const digest = snapshot.kind === 'bundle' ? snapshot.digest : '';

  expect(digest).toMatch(sha256Hex);
});

it('reports an edited project guide as broken, never as the bundle', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(repository, { language: 'rust' });
  await appendFile(join(repository, 'docs', 'stomme', 'languages', 'rust', 'guide.md'), 'edit\n');
  const before = await readTree(join(repository, 'docs'));
  const configBefore = await readFile(join(repository, 'stomme.toml'), 'utf8');

  const snapshot = await resolveStommeGuides(repository);

  expect(await readTree(join(repository, 'docs'))).toEqual(before);
  expect(await readFile(join(repository, 'stomme.toml'), 'utf8')).toBe(configBefore);

  expect(snapshot).toMatchObject({ kind: 'broken', root: repository });
  const reason = snapshot.kind === 'broken' ? snapshot.reason : '';

  expect(reason).toContain('differs from its record');
});

it('gives equal projects one digest', async ({ onTestFinished }) => {
  const first = await createTemporaryRepository(onTestFinished);
  const second = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(first, { language: 'rust', layers: ['gpui'] });
  await writeStommeProject(second, { language: 'rust', layers: ['gpui'] });

  const firstDigest = await digestOf(first);

  expect(firstDigest).toMatch(sha256Hex);
  expect(await digestOf(second)).toBe(firstDigest);
});

it('keeps the digest when an unselected layer guide is added', async ({ onTestFinished }) => {
  const plain = await createTemporaryRepository(onTestFinished);
  const withLayer = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(plain, { language: 'rust' });
  await writeStommeProject(withLayer, { language: 'rust', recordedLayers: ['gpui'] });

  expect(await digestOf(withLayer)).toBe(await digestOf(plain));
});

it('changes the digest when a layer is selected', async ({ onTestFinished }) => {
  const plain = await createTemporaryRepository(onTestFinished);
  const withLayer = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(plain, { language: 'rust' });
  await writeStommeProject(withLayer, { language: 'rust', layers: ['gpui'] });

  expect(await digestOf(withLayer)).not.toBe(await digestOf(plain));
});

it('changes the digest when the version changes', async ({ onTestFinished }) => {
  const current = await createTemporaryRepository(onTestFinished);
  const newer = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(current, { language: 'rust' });
  await writeStommeProject(newer, { language: 'rust', version: '0.2.1' });

  expect(await digestOf(newer)).not.toBe(await digestOf(current));
});

it('reports a configured project without a record as broken', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(repository, { language: 'rust' });
  await rm(join(repository, 'docs', 'stomme', '.sync-record.toml'));

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot).toMatchObject({ kind: 'broken', root: repository });
  expect(reasonOf(snapshot)).toContain('.sync-record.toml');
});

it('reports a dangling stomme.toml link as broken, not as a higher config or the bundle', async ({
  onTestFinished,
}) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(repository, { language: 'rust' });
  const subfolder = join(repository, 'sub');
  await mkdir(subfolder);
  await symlink(join(repository, 'gone.toml'), join(subfolder, 'stomme.toml'));

  const snapshot = await resolveStommeGuides(subfolder);

  expect(snapshot).toMatchObject({ kind: 'broken', root: subfolder });
});

it('reports a stomme.toml that is not a regular file as broken', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await makePipe(join(repository, 'stomme.toml'), onTestFinished);

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot).toMatchObject({ kind: 'broken', root: repository });
  expect(reasonOf(snapshot)).toContain('not a regular file');
}, 2000);

it('does not read a config above the nearest config', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(repository, { language: 'rust' });
  const subfolder = join(repository, 'sub');
  await mkdir(subfolder);
  await writeStommeProject(subfolder, { language: 'typescript' });
  await rm(join(repository, 'stomme.toml'));
  await makePipe(join(repository, 'stomme.toml'), onTestFinished);

  const snapshot = await resolveStommeGuides(subfolder);

  expect(snapshot).toMatchObject({ kind: 'project', root: subfolder, language: 'typescript' });
}, 2000);

it('reports a working directory it cannot probe as broken instead of rejecting', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-stomme-file-');
  const file = join(directory, 'file');
  await writeFile(file, 'not a folder');

  const snapshot = await resolveStommeGuides(join(file, 'inside'));

  expect(snapshot.kind).toBe('broken');
});

it('resolves a project again after its version and layers change', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(repository, { language: 'typescript' });

  await writeStommeProject(repository, {
    language: 'typescript',
    version: '0.2.1',
    layers: ['react'],
  });

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot).toMatchObject({
    kind: 'project',
    version: '0.2.1',
    layers: ['react'],
  });
});

it('resolves a project whose layer is both selected and recorded', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  await writeStommeProject(repository, {
    language: 'typescript',
    layers: ['react'],
    recordedLayers: ['react'],
  });

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot).toMatchObject({ kind: 'project', layers: ['react'] });
});

it('does not stall when the config becomes a pipe after its type check', async ({
  onTestFinished,
}) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await writeStommeProject(repository, { language: 'rust' });
  const config = join(repository, 'stomme.toml');

  swap.afterStat = async (path) => {
    if (path === config) {
      await rm(config);
      await makePipe(config, onTestFinished);
    }
  };

  onTestFinished(() => {
    swap.afterStat = undefined;
  });

  const snapshot = await resolveStommeGuides(repository);

  expect(snapshot.kind).not.toBe('bundle');
}, 2000);
