import { execFile } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { workingState } from './preparation.js';
import * as recovery from './recovery.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fileSystem>();

  return {
    ...original,
    rename: vi.fn<typeof rename>(original.rename),
    link: vi.fn<typeof link>(original.link),
    open: vi.fn<typeof open>(original.open),
    readFile: vi.fn<typeof readFile>(original.readFile),
  };
});

const execute = promisify(execFile);
const directories: string[] = [];
const git = async (root: string, arguments_: string[]) =>
  (await execute('git', arguments_, { cwd: root })).stdout.trim();
const pi: Pick<ExtensionAPI, 'exec'> = {
  async exec(command, arguments_, options) {
    const result = await execute(command, arguments_, { cwd: options?.cwd });

    return { ...result, code: 0, killed: false };
  },
};
const file = (content: string, mode = 0o600) => ({
  kind: 'file' as const,
  mode,
  content: Buffer.from(content).toString('base64'),
});
const readOptional = (path: string) =>
  readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });
const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-raw-recovery-'));
  directories.push(root);

  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await writeFile(join(root, 'file'), 'base');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);
  await writeFile(join(root, 'file'), 'staged only');
  await git(root, ['add', '.']);
  await writeFile(join(root, 'file'), Buffer.from([0, 255, 13, 10]));
  await chmod(join(root, 'file'), 0o600);

  return root;
};
afterEach(async () => {
  vi.restoreAllMocks();
  const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
  vi.mocked(rename).mockImplementation(original.rename);
  vi.mocked(link).mockImplementation(original.link);
  vi.mocked(open).mockImplementation(original.open);
  vi.mocked(readFile).mockImplementation(original.readFile);

  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('saves verified raw state and restores bytes modes links absence and exact staging', async () => {
  const root = await repository();
  await symlink('missing\r\n', join(root, 'link'));
  await writeFile(join(root, 'deleted'), 'staged deletion');
  await git(root, ['add', 'deleted']);
  await rm(join(root, 'deleted'));
  const index = await readFile(join(root, '.git/index'));
  const original = await readFile(join(root, 'file'));
  const archive = await recovery.saveRecovery(pi, root, {
    file: file('hidden'),
    link: null,
    deleted: file('hidden deletion'),
  });

  await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(/recovery/i);
  await writeFile(join(root, 'file'), 'hidden');
  await rm(join(root, 'link'));
  await writeFile(join(root, 'deleted'), 'hidden deletion', { mode: 0o600 });
  await recovery.recoverPending(pi, root);

  expect(await readFile(join(root, 'file'))).toEqual(original);
  expect((await lstat(join(root, 'file'))).mode & 0o777).toBe(0o600);
  expect((await lstat(join(root, 'file'))).nlink).toBe(1);
  expect(await readlink(join(root, 'link'))).toBe('missing\r\n');
  await expect(lstat(join(root, 'deleted'))).rejects.toThrow(/ENOENT/);
  expect(await readFile(join(root, '.git/index'))).toEqual(index);
  await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).resolves.toBeUndefined();
  expect((await lstat(archive)).isDirectory()).toBe(true);
});

it('hides with verified displacement and refuses publication collisions', async () => {
  const root = await repository();
  const hidden = { file: file('hidden') };
  const archive = await recovery.saveRecovery(pi, root, hidden);
  const hide = recovery.hidePending;
  const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
  vi.mocked(link).mockImplementationOnce(async (source, destination) => {
    await writeFile(destination, 'concurrent publication');
    await original.link(source, destination);
  });

  expect(hide).toBeTypeOf('function');
  await expect(hide(pi, root)).rejects.toThrow(/EEXIST/);
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('concurrent publication');
  expect(await readFile(join(archive, 'hidden-displaced/0'))).toEqual(
    Buffer.from([0, 255, 13, 10]),
  );
  await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(/recovery/i);
});

it.each(['displacement', 'publication'])(
  'retains both states after abrupt hiding death at %s',
  async (boundary) => {
    const root = await repository();
    await writeFile(join(root, 'second'), 'second original', { mode: 0o600 });
    const archive = await recovery.saveRecovery(pi, root, { file: file('hidden'), second: null });
    const index = await readFile(join(root, '.git/index'));
    const script = `
    import filesystem from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    import { createJiti } from 'jiti';
    const method = ${JSON.stringify(boundary === 'displacement' ? 'rename' : 'link')};
    const original = filesystem[method];
    filesystem[method] = async (...arguments_) => {
      await original(...arguments_);
      process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    const execute = promisify(execFile);
    const pi = { exec: async (command, arguments_, options) => ({ ...await execute(command, arguments_, { cwd: options.cwd }), code: 0, killed: false }) };
    const recovery = await createJiti(import.meta.url).import(${JSON.stringify(join(import.meta.dirname, 'recovery.ts'))});
    await recovery.hidePending(pi, ${JSON.stringify(root)});
    throw new Error('boundary not reached');
  `;

    await expect(
      execute(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd() }),
    ).rejects.toMatchObject({ signal: 'SIGKILL' });
    expect(await readFile(join(archive, 'hidden-displaced/0'))).toEqual(
      Buffer.from([0, 255, 13, 10]),
    );
    expect(await readFile(join(root, 'file'), 'utf8').catch(() => null)).toBe(
      boundary === 'publication' ? 'hidden' : null,
    );
    expect(await readFile(join(root, 'second'), 'utf8')).toBe('second original');
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
    await expect(recovery.recoverPending(pi, root)).rejects.toThrow(/EEXIST/);
    await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(/recovery/i);
  },
  20_000,
);

it('keeps original open-writer inodes after hiding and restoration', async () => {
  const root = await repository();
  const archive = await recovery.saveRecovery(pi, root, { file: file('hidden') });
  const writer = await open(join(root, 'file'), 'a');

  try {
    const window = await recovery.hidePending(pi, root);
    await window.restore();
    await writer.write(' late original writer');

    expect(await readFile(join(root, 'file'))).toEqual(Buffer.from([0, 255, 13, 10]));
    expect(await readFile(join(archive, 'hidden-displaced/0'))).toEqual(
      Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from(' late original writer')]),
    );
  } finally {
    await writer.close();
  }
});

it('does not carry existing ignored dependency files as new artifacts', async () => {
  const root = await repository();
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n');
  await mkdir(join(root, 'node_modules'));
  await mkdir(join(root, 'dist'));
  await Promise.all(
    Array.from({ length: 100 }, (_, position) =>
      writeFile(join(root, 'node_modules', `dependency-${position}`), 'installed'),
    ),
  );
  await writeFile(join(root, 'dist/result'), 'new build');
  const expected = await workingState(root);
  const artifacts = await recovery.newIgnoredArtifacts(root, expected, undefined, [
    'node_modules/',
  ]);

  expect(artifacts).toEqual(['dist/result']);
});

it('packs only saved tree objects without syncing or rewriting unrelated history', async () => {
  const root = await repository();
  await writeFile(join(root, 'unrelated'), 'historical data not in the saved tree');
  await git(root, ['add', 'unrelated']);
  await git(root, ['commit', '-m', 'historical data']);
  const historicalObject = await git(root, ['rev-parse', 'HEAD:unrelated']);
  await git(root, ['rm', 'unrelated']);
  await git(root, ['commit', '-m', 'remove historical data']);
  await git(root, ['gc', '--prune=now']);
  const packs = join(root, '.git/objects/pack');
  const historicalNames = await readdir(packs);
  const historicalBytes = await Promise.all(
    historicalNames.map((name) => readFile(join(packs, name))),
  );
  const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
  const synced: string[] = [];

  vi.mocked(open).mockImplementation(async (path, ...arguments_) => {
    const handle = await original.open(path, ...arguments_);
    const synchronize = handle.sync.bind(handle);
    handle.sync = async () => {
      synced.push(String(path));
      await synchronize();
    };

    return handle;
  });
  await recovery.saveRecovery(pi, root, {});
  const added = (await readdir(packs)).filter((name) => !historicalNames.includes(name));
  const indexes = added.filter((name) => name.endsWith('.idx'));

  expect(indexes).toHaveLength(1);
  const index = indexes[0]!;
  const contents = await git(root, ['verify-pack', '-v', join(packs, index)]);
  expect(contents).not.toContain(historicalObject);
  const savedTree = await git(root, ['write-tree']);
  const savedBlob = await git(root, ['rev-parse', ':file']);
  const packedObjects = contents
    .split('\n')
    .filter((line) => /^[a-f0-9]+ (?:blob|tree|commit|tag) /.test(line))
    .map((line) => line.split(' ')[0]!);
  expect(packedObjects.toSorted()).toEqual([savedTree, savedBlob].toSorted());
  expect(synced).toContain(join(packs, index));
  expect(synced).toContain(join(packs, index.replace(/\.idx$/, '.pack')));
  expect(
    synced.filter((path) => historicalNames.some((name) => path === join(packs, name))),
  ).toEqual([]);
  expect(await Promise.all(historicalNames.map((name) => readFile(join(packs, name))))).toEqual(
    historicalBytes,
  );
});

it.each(['.pack', '.idx'])(
  'refuses authorization when new %s readback fails',
  async (extension) => {
    const root = await repository();
    const original = await vi.importActual<typeof fileSystem>('node:fs/promises');

    vi.mocked(open).mockImplementation(async (path, ...arguments_) => {
      const handle = await original.open(path, ...arguments_);

      if (String(path).endsWith(extension)) {
        const synchronize = handle.sync.bind(handle);
        handle.sync = async () => {
          await synchronize();
          await writeFile(path, 'corrupt new object storage');
        };
      }

      return handle;
    });

    await expect(recovery.saveRecovery(pi, root, {})).rejects.toThrow(/pack|index/i);
    await expect(lstat(join(root, '.git/tau-recovery/pending/ready'))).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(root, 'file'))).toEqual(Buffer.from([0, 255, 13, 10]));
  },
);

it('reads each working file only once per boundary during restoration', async () => {
  const root = await repository();
  await writeFile(join(root, 'second'), 'original second', { mode: 0o600 });
  await writeFile(join(root, 'third'), 'original third', { mode: 0o600 });
  const paths = ['file', 'second', 'third'];
  await recovery.saveRecovery(
    pi,
    root,
    Object.fromEntries(paths.map((path) => [path, file('hidden')])),
  );
  await Promise.all(paths.map((path) => writeFile(join(root, path), 'hidden')));
  vi.mocked(readFile).mockClear();

  await recovery.recoverPending(pi, root);

  const counts = paths.map(
    (path) =>
      vi.mocked(readFile).mock.calls.filter(([readPath]) => readPath === join(root, path)).length,
  );
  expect(counts).toEqual([3, 3, 3]);
  expect(await readFile(join(root, 'second'), 'utf8')).toBe('original second');
  expect(await readFile(join(root, 'third'), 'utf8')).toBe('original third');
});

it('protects staged-only objects after index replacement and garbage collection', async () => {
  const root = await repository();
  const object = await git(root, ['rev-parse', ':file']);
  await recovery.saveRecovery(pi, root, {});
  await git(root, ['reset', '--mixed', 'HEAD']);
  await git(root, ['reflog', 'expire', '--expire=now', '--all']);
  await git(root, ['gc', '--prune=now']);

  expect(await git(root, ['cat-file', '-p', object])).toBe('staged only');
  await expect(recovery.recoverPending(pi, root)).rejects.toThrow(/index/i);
});

it('allows cancellation before hiding but authorizes only one pending window', async () => {
  const root = await repository();
  const results = await Promise.allSettled([
    recovery.saveRecovery(pi, root, { file: file('hidden') }),
    recovery.saveRecovery(pi, root, { file: file('hidden') }),
  ]);

  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  await recovery.recoverPending(pi, root);
  await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).resolves.toBeUndefined();
});

it('refuses hardlinks and directory transitions before authorizing hiding', async () => {
  const root = await repository();
  await link(join(root, 'file'), join(root, 'alias'));

  await expect(recovery.saveRecovery(pi, root, {})).rejects.toThrow(/hardlink/i);
  expect(await readFile(join(root, 'file'))).toEqual(Buffer.from([0, 255, 13, 10]));

  const transitionRoot = await repository();
  await expect(
    recovery.saveRecovery(pi, transitionRoot, { 'file/child': file('hidden') }),
  ).rejects.toThrow(/transition/);
  expect(await readFile(join(transitionRoot, 'file'))).toEqual(Buffer.from([0, 255, 13, 10]));
});

it('refuses partial hiding and retains unexpected work', async () => {
  const root = await repository();
  await writeFile(join(root, 'second'), 'original');
  await recovery.saveRecovery(pi, root, { file: file('hidden'), second: file('hidden') });
  await writeFile(join(root, 'file'), 'hidden');

  await expect(recovery.recoverPending(pi, root)).rejects.toThrow(/state|partial/i);
  expect(await readFile(join(root, 'second'), 'utf8')).toBe('original');
  await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(/recovery/i);
});

it.each(['manifest.json', 'working.json', 'original-index', 'manifest.sha256'])(
  'retains work when backup %s is corrupt',
  async (name) => {
    const root = await repository();
    const archive = await recovery.saveRecovery(pi, root, { file: file('hidden') });
    await writeFile(join(archive, name), 'corrupt');
    await writeFile(join(root, 'file'), 'hidden');

    await expect(recovery.recoverPending(pi, root)).rejects.toThrow(/recovery/i);
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('hidden');
    await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(
      archive.slice(0, archive.lastIndexOf('/')),
    );
  },
);

it.each(['directory', 'file', 'symlink'])(
  'blocks an incomplete %s pending marker',
  async (kind) => {
    const root = await repository();
    const directory = join(root, '.git/tau-recovery');
    await mkdir(directory);

    if (kind === 'directory') {
      await mkdir(join(directory, 'pending'));
    } else if (kind === 'file') {
      await writeFile(join(directory, 'pending'), 'broken');
    } else {
      await symlink('missing', join(directory, 'pending'));
    }

    await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(directory);
    await expect(recovery.recoverPending(pi, root)).rejects.toThrow(directory);
  },
);

it.each(['HEAD', 'index', 'work', 'collision', 'parent'])(
  'refuses unexpected %s without overwriting it',
  async (change) => {
    const root = await repository();
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/file'), 'original');
    await recovery.saveRecovery(pi, root, { file: file('hidden') });
    await writeFile(join(root, 'file'), 'hidden');

    if (change === 'HEAD') {
      await git(root, ['commit', '-m', 'concurrent']);
    } else if (change === 'index') {
      await git(root, ['add', 'file']);
    } else if (change === 'work') {
      await writeFile(join(root, 'file'), 'unexpected');
    } else if (change === 'collision') {
      await writeFile(join(root, 'new'), 'new user work');
    } else {
      await rename(join(root, 'nested'), join(root, 'outside'));
      await symlink('outside', join(root, 'nested'));
    }

    const index = await readFile(join(root, '.git/index'));
    await expect(recovery.recoverPending(pi, root)).rejects.toThrow(/recovery/i);
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
    expect(await readFile(join(root, 'file'), 'utf8')).toBe(
      change === 'work' ? 'unexpected' : 'hidden',
    );

    const newContent = await readFile(join(root, 'new'), 'utf8').catch(() => null);
    expect(newContent).toBe(change === 'collision' ? 'new user work' : null);
  },
);

it.each(['complete', 'raced', 'failure'])(
  'syncs displaced regular bytes before recovery %s',
  async (outcome) => {
    const root = await repository();
    const archive = await recovery.saveRecovery(pi, root, { file: file('hidden') });
    await writeFile(join(root, 'file'), 'hidden');
    const saved = join(archive, 'displaced/0');
    const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
    let syncCalls = 0;
    let closed = false;
    let publishedAfterSync = false;

    vi.mocked(open).mockImplementation(async (path, ...arguments_) => {
      const handle = await original.open(path, ...arguments_);

      if (String(path) === saved) {
        const synchronize = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        handle.sync = async () => {
          syncCalls += 1;

          if (outcome === 'failure') {
            throw new Error('displaced sync failed');
          }

          await synchronize();
        };
        handle.close = async () => {
          closed = true;
          await close();
        };
      }

      return handle;
    });
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      if (outcome === 'raced') {
        await writeFile(source, 'raced user bytes');
      }

      await original.rename(source, destination);
    });
    vi.mocked(link).mockImplementation(async (source, destination) => {
      publishedAfterSync = syncCalls > 0;
      await original.link(source, destination);
    });

    const failure = await recovery.recoverPending(pi, root).then(
      () => '',
      (error: unknown) => String(error),
    );

    let expectedFailure = /^$/;

    if (outcome === 'raced') {
      expectedFailure = /Raced bytes/;
    } else if (outcome === 'failure') {
      expectedFailure = /displaced sync failed/;
    }

    expect(syncCalls).toBe(1);
    expect(closed).toBe(true);
    expect(publishedAfterSync).toBe(outcome === 'complete');
    expect(failure).toMatch(expectedFailure);
    expect(await readFile(saved, 'utf8')).toBe(outcome === 'raced' ? 'raced user bytes' : 'hidden');
    const pending = await recovery.assertNoPendingRecovery(join(root, '.git')).then(
      () => false,
      () => true,
    );
    expect(pending).toBe(outcome !== 'complete');
    const current = await readFile(join(root, 'file')).catch(() => null);
    expect(current).toEqual(outcome === 'complete' ? Buffer.from([0, 255, 13, 10]) : null);
    const backup = await readOptional(join(archive, 'working.json'));
    const originalBase64 = Buffer.from([0, 255, 13, 10]).toString('base64');
    expect(backup?.includes(originalBase64) ?? 'pruned').toBe(
      outcome === 'complete' ? 'pruned' : true,
    );
  },
);

it('retains displaced raced bytes and refuses publication collisions', async () => {
  const root = await repository();
  const archive = await recovery.saveRecovery(pi, root, { file: file('hidden') });
  await writeFile(join(root, 'file'), 'hidden');
  const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
  vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
    await writeFile(source, 'raced bytes');
    await original.rename(source, destination);
  });

  await expect(recovery.recoverPending(pi, root)).rejects.toThrow(/Raced bytes/);
  expect(await readFile(join(archive, 'displaced/0'), 'utf8')).toBe('raced bytes');
  const backup: unknown = JSON.parse(await readFile(join(archive, 'working.json'), 'utf8'));
  expect(backup).toMatchObject({
    file: { content: Buffer.from([0, 255, 13, 10]).toString('base64') },
  });

  const collisionRoot = await repository();
  await recovery.saveRecovery(pi, collisionRoot, { file: file('hidden') });
  await writeFile(join(collisionRoot, 'file'), 'hidden');
  vi.mocked(link).mockImplementationOnce(async (source, destination) => {
    await writeFile(destination, 'new user bytes');
    await original.link(source, destination);
  });

  await expect(recovery.recoverPending(pi, collisionRoot)).rejects.toThrow(/EEXIST/);
  expect(await readFile(join(collisionRoot, 'file'), 'utf8')).toBe('new user bytes');
});

it('keeps displaced inodes for open writers and excludes a second recovery caller', async () => {
  const root = await repository();
  const archive = await recovery.saveRecovery(pi, root, { file: file('hidden') });
  await writeFile(join(root, 'file'), 'hidden');
  const writer = await open(join(root, 'file'), 'a');

  try {
    const results = await Promise.allSettled([
      recovery.recoverPending(pi, root),
      recovery.recoverPending(pi, root),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await writer.write(' late writer');
    expect(await readFile(join(archive, 'displaced/0'), 'utf8')).toBe('hidden late writer');
    expect(await readFile(join(root, 'file'))).toEqual(Buffer.from([0, 255, 13, 10]));
  } finally {
    await writer.close();
  }
});

it.each(['backup', 'ready', 'displacement', 'publication', 'completion'])(
  'retains recovery data after abrupt subprocess death at %s',
  async (boundary) => {
    const root = await repository();
    const saving = boundary === 'backup' || boundary === 'ready';
    let archive = '';

    if (!saving) {
      archive = await recovery.saveRecovery(pi, root, { file: file('hidden') });
      await writeFile(join(root, 'file'), 'hidden');
    }

    const script = `
    import filesystem from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    import { createJiti } from 'jiti';
    const root = ${JSON.stringify(root)};
    const boundary = ${JSON.stringify(boundary)};
    const die = () => process.kill(process.pid, 'SIGKILL');
    const originalOpen = filesystem.open;
    filesystem.open = async (path, ...arguments_) => {
      const handle = await originalOpen(path, ...arguments_);
      if ((boundary === 'backup' && String(path).endsWith('manifest.json')) || (boundary === 'ready' && String(path).endsWith('/ready'))) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => { await originalSync(); die(); };
      }
      return handle;
    };
    for (const [method, selected] of [['rename', 'displacement'], ['link', 'publication']]) {
      const original = filesystem[method];
      filesystem[method] = async (...arguments_) => {
        const result = await original(...arguments_);
        if (boundary === selected) die();
        return result;
      };
    }
    const originalRemove = filesystem.rm;
    filesystem.rm = async (path, ...arguments_) => {
      if (boundary === 'completion' && String(path).endsWith('/pending')) die();
      return originalRemove(path, ...arguments_);
    };
    syncBuiltinESMExports();
    const jiti = createJiti(import.meta.url);
    const recovery = await jiti.import(${JSON.stringify(join(import.meta.dirname, 'recovery.ts'))});
    const execute = promisify(execFile);
    const pi = { exec: async (command, arguments_, options) => ({ ...await execute(command, arguments_, { cwd: options.cwd }), code: 0, killed: false }) };
    if (${saving}) await recovery.saveRecovery(pi, root, { file: ${JSON.stringify(file('hidden'))} });
    else await recovery.recoverPending(pi, root);
    throw new Error('boundary not reached');
  `;

    await expect(
      execute(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd() }),
    ).rejects.toMatchObject({ signal: 'SIGKILL' });
    await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(/recovery/i);

    const name = await readFile(join(root, '.git/tau-recovery/pending/archive'), 'utf8');
    archive = join(root, '.git/tau-recovery', name);
    const current = await readFile(join(root, 'file')).catch(() => null);
    expect(current).toEqual(boundary === 'displacement' ? null : Buffer.from([0, 255, 13, 10]));
    const backup: unknown = JSON.parse(await readFile(join(archive, 'working.json'), 'utf8'));
    expect(backup).toMatchObject({
      file: { content: Buffer.from([0, 255, 13, 10]).toString('base64') },
    });
    expect(await readFile(join(archive, 'original-index'))).toEqual(
      await readFile(join(root, '.git/index')),
    );

    const displaced = await readFile(join(archive, 'displaced/0'), 'utf8').catch(() => null);
    expect(displaced).toBe(saving ? null : 'hidden');
    await expect(recovery.recoverPending(pi, root)).rejects.toThrow(/EEXIST/);
  },
  20000,
);

it('refuses a changed HEAD reference even when the commit is unchanged', async () => {
  const root = await repository();
  await git(root, ['branch', 'other']);
  await recovery.saveRecovery(pi, root, { file: file('hidden') });
  await writeFile(join(root, 'file'), 'hidden');
  await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/other']);

  await expect(recovery.recoverPending(pi, root)).rejects.toThrow(/HEAD/);
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('hidden');
});

it('rejects late writes before returning permission to hide', async () => {
  const root = await repository();
  const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
  vi.mocked(open).mockImplementation(async (path, ...arguments_) => {
    const handle = await original.open(path, ...arguments_);

    if (String(path).endsWith('/ready')) {
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        await originalSync();
        await writeFile(join(root, 'file'), 'late write');
      };
    }

    return handle;
  });

  await expect(recovery.saveRecovery(pi, root, { file: file('hidden') })).rejects.toThrow(
    /changed/,
  );
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('late write');
});

it('does not let recovery acquire ownership during save', async () => {
  const root = await repository();
  const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
  let recoveryError: unknown;
  vi.mocked(open).mockImplementation(async (path, ...arguments_) => {
    const handle = await original.open(path, ...arguments_);

    if (String(path).endsWith('/ready') && arguments_[0] === 'wx') {
      await recovery.recoverPending(pi, root).catch((error: unknown) => {
        recoveryError = error;
      });
    }

    return handle;
  });

  await recovery.saveRecovery(pi, root, {});
  expect(recoveryError instanceof Error ? recoveryError.message : recoveryError).toMatch(/EEXIST/);
});

it('refuses a special backup file without waiting for a writer', async () => {
  const root = await repository();
  const archive = await recovery.saveRecovery(pi, root, { file: file('hidden') });
  await rm(join(archive, 'original-index'));
  await execute('mkfifo', [join(archive, 'original-index')]);
  const script = `
    import { createJiti } from 'jiti';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    const execute = promisify(execFile);
    const jiti = createJiti(import.meta.url);
    const recovery = await jiti.import(${JSON.stringify(join(import.meta.dirname, 'recovery.ts'))});
    const pi = { exec: async (command, arguments_, options) => ({ ...await execute(command, arguments_, { cwd: options.cwd }), code: 0, killed: false }) };
    try { await recovery.recoverPending(pi, ${JSON.stringify(root)}); }
    catch (error) { console.error(String(error)); process.exitCode = 2; }
  `;
  const failure = await execute(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    timeout: 3000,
  }).then(
    () => '',
    (error: unknown) =>
      error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error),
  );

  expect(failure).toContain('Unsupported recovery file');
  expect(await readFile(join(root, 'file'))).toEqual(Buffer.from([0, 255, 13, 10]));
}, 10000);

it('retains pending state after backup and restoration write failures', async () => {
  const root = await repository();
  const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
  vi.mocked(open).mockImplementation(async (path, ...arguments_) => {
    if (String(path).endsWith('manifest.json')) {
      throw new Error('injected write failure');
    }

    return original.open(path, ...arguments_);
  });

  await expect(recovery.saveRecovery(pi, root, {})).rejects.toThrow(/write failure/);
  expect(await readFile(join(root, 'file'))).toEqual(Buffer.from([0, 255, 13, 10]));
  await expect(recovery.assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(/recovery/i);
  vi.mocked(open).mockImplementation(original.open);

  const restoreRoot = await repository();
  await recovery.saveRecovery(pi, restoreRoot, { file: file('hidden') });
  await writeFile(join(restoreRoot, 'file'), 'hidden');
  vi.mocked(link).mockRejectedValueOnce(new Error('injected publication failure'));

  await expect(recovery.recoverPending(pi, restoreRoot)).rejects.toThrow(/publication failure/);
  await expect(recovery.assertNoPendingRecovery(join(restoreRoot, '.git'))).rejects.toThrow(
    /recovery/i,
  );
});
