import type * as fileSystem from 'node:fs/promises';
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createCommitTool,
  runCommand,
  git,
  createTemporaryRepository,
  writeRepositoryFile,
  commitContext,
  executeCommit,
} from '../../../tests/commitTool.js';
import type { reviewComments } from './commentReview.js';
import { createCommitTool as createReviewedCommitTool } from './tool.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fileSystem>();

  return {
    ...original,
    rename: vi.fn<typeof rename>(original.rename),
    rm: vi.fn<typeof rm>(original.rm),
  };
});

const fixture = async (script: string) => {
  const directory = await createTemporaryRepository();

  await writeRepositoryFile(
    directory,
    'tau.json',
    JSON.stringify({ prepare: ['node', '-e', script] }),
  );
  await writeRepositoryFile(directory, 'requested', 'base');
  await writeRepositoryFile(directory, 'other', 'base');
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', 'test: baseline']);
  await writeRepositoryFile(directory, 'requested', 'staged');
  await git(directory, ['add', 'requested']);
  await writeRepositoryFile(directory, 'requested', 'working');
  await writeRepositoryFile(directory, 'user data\n.txt', 'untracked prior bytes');

  return directory;
};

const recovery = async (directory: string) => {
  const root = (
    await git(directory, ['rev-parse', '--path-format=absolute', '--git-path', 'tau-recovery'])
  ).trim();
  const paths = await readdir(root);
  const path = join(root, paths[0]!);
  const working = JSON.parse(await readFile(join(path, 'working.json'), 'utf8')) as Record<
    string,
    { content: string; kind: string; mode: number } | null
  >;

  return { path, working };
};

describe('preparation ownership', () => {
  it('allows index cache refreshes but restores the exact original index', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'formatted')");
    const originalIndex = await readFile(join(directory, '.git/index'));
    const controller = new AbortController();
    const tool = createReviewedCommitTool(
      {
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      },
      async () => {
        await writeFile(join(directory, 'requested'), 'formatted');
        await git(directory, ['update-index', '--refresh']);
        controller.abort();

        return { findings: [] };
      },
    );
    const result = await tool.execute(
      'refresh',
      { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
      controller.signal,
      undefined,
      commitContext(directory),
    );

    expect(result.details.groups[0]?.sha).toBe('');
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
  });

  it.each(['generated', 'requested'])(
    'retains staged-only preparation output for %s',
    async (path) => {
      const directory = await fixture(`
      const fileSystem = require('node:fs');
      fileSystem.writeFileSync('${path}', 'index-only bytes');
      require('node:child_process').execFileSync('git', ['add', '${path}']);
      ${path === 'generated' ? `fileSystem.unlinkSync('${path}');` : `fileSystem.writeFileSync('${path}', 'working');`}
    `);
      const originalIndex = await readFile(join(directory, '.git/index'));
      const originalHead = await git(directory, ['rev-parse', 'HEAD']);

      await expect(
        executeCommit(directory, {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        }),
      ).rejects.toThrow(/Staged-only preparation output.*Inspect.*retry/s);

      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
      expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(originalHead);
      const root = join(directory, '.git/tau-recovery');
      const archives = await readdir(root);
      const preparedRef = (await readFile(join(root, archives[0]!, 'prepared-ref'), 'utf8')).trim();
      await git(directory, ['gc', '--prune=now']);
      expect(await git(directory, ['show', `${preparedRef}:${path}`])).toBe('index-only bytes');
      expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
    },
  );

  it('retains staged-only preparation deletions without changing user state', async () => {
    const directory = await fixture(
      "require('node:child_process').execFileSync('git', ['rm', '--cached', 'requested']);",
    );
    const originalIndex = await readFile(join(directory, '.git/index'));
    const originalHead = await git(directory, ['rev-parse', 'HEAD']);

    await expect(
      executeCommit(directory, {
        groups: [{ files: ['requested'], subject: 'feat: requested' }],
      }),
    ).rejects.toThrow(/Staged-only preparation output.*requested.*Recovery saved/s);

    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
    expect(await readFile(join(directory, 'user data\n.txt'), 'utf8')).toBe(
      'untracked prior bytes',
    );

    const saved = await recovery(directory);
    const preparedRef = (await readFile(join(saved.path, 'prepared-ref'), 'utf8')).trim();

    await git(directory, ['gc', '--prune=now']);

    expect(await git(directory, ['ls-tree', '--name-only', preparedRef, '--', 'requested'])).toBe(
      '',
    );
    expect(await git(directory, ['show', `${preparedRef}:other`])).toBe('base');
    expect(await readFile(join(saved.path, 'original-index'))).toEqual(originalIndex);
  });

  it.each([
    ['failure', 'generated'],
    ['failure', 'requested'],
    ['cancellation', 'generated'],
    ['cancellation', 'requested'],
  ])('retains private-index output after %s for %s', async (outcome, path) => {
    const directory = await fixture(`
      const fileSystem = require('node:fs');
      fileSystem.writeFileSync('${path}', 'private output');
      require('node:child_process').execFileSync('git', ['add', '${path}']);
      ${path === 'generated' ? `fileSystem.unlinkSync('${path}');` : `fileSystem.writeFileSync('${path}', 'working');`}
      console.error('preparation diagnostic');
      process.exitCode = ${outcome === 'failure' ? 1 : 0};
    `);
    const originalIndex = await readFile(join(directory, '.git/index'));
    const originalHead = await git(directory, ['rev-parse', 'HEAD']);
    const controller = new AbortController();
    const tool = createCommitTool({
      exec: async (command, arguments_, options) => {
        const result = await runCommand(command, arguments_, options?.cwd ?? directory);

        if (outcome === 'cancellation' && command === 'env' && arguments_.includes('node')) {
          controller.abort();
        }

        return result;
      },
    });

    const execution = tool.execute(
      'call',
      { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
      controller.signal,
      undefined,
      commitContext(directory),
    );

    const result = await execution.then(
      (value) => ({ failed: false, report: JSON.stringify(value) }),
      (error: unknown) => ({ failed: true, report: String(error) }),
    );

    expect(result.failed).toBe(outcome === 'failure');
    expect(result.report).toMatch(
      outcome === 'failure'
        ? /Project preparation failed.*preparation diagnostic.*Recovery saved/s
        : /Commit cancelled.*Recovery saved.*"sha":""/s,
    );

    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
    await expect(readFile(join(directory, 'generated'))).rejects.toThrow(/ENOENT/);

    const root = join(directory, '.git/tau-recovery');
    const archives = await readdir(root);
    const preparedRef = (await readFile(join(root, archives[0]!, 'prepared-ref'), 'utf8')).trim();

    await git(directory, ['gc', '--prune=now']);

    expect(await git(directory, ['show', `${preparedRef}:${path}`])).toBe('private output');
    expect(await git(directory, ['show', ':requested'])).toBe('staged');
  });

  it('keeps the preparation diagnostic when private-index preservation fails', async () => {
    const directory = await fixture("throw new Error('preparation diagnostic')");
    const originalIndex = await readFile(join(directory, '.git/index'));
    const tool = createCommitTool({
      exec: (command, arguments_, options) => {
        if (arguments_[0] === 'update-ref' && arguments_[1]?.endsWith('-prepared')) {
          return Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'pin failed' });
        }

        return runCommand(command, arguments_, options?.cwd ?? directory);
      },
    });

    await expect(
      tool.execute(
        'call',
        { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
        undefined,
        undefined,
        commitContext(directory),
      ),
    ).rejects.toThrow(
      /Project preparation failed.*preparation diagnostic.*Private-index recovery failed.*pin failed.*Do not prune Git objects.*Recovery saved/s,
    );

    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it('does not remove a later writer lock after publishing its index', async () => {
    const directory = await fixture('');
    const original = await vi.importActual<typeof fileSystem>('node:fs/promises');

    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await original.rename(source, destination);
      await writeFile(`${String(destination)}.lock`, 'another writer');
    });

    try {
      await expect(
        executeCommit(directory, {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        }),
      ).rejects.toThrow(/lock/);
      expect(await readFile(join(directory, '.git/index.lock'), 'utf8')).toBe('another writer');
    } finally {
      vi.mocked(rename).mockImplementation(original.rename);
    }
  });

  it('rejects paths assigned to two groups before preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    const originalIndex = await readFile(join(directory, '.git/index'));

    await expect(
      executeCommit(directory, {
        groups: [
          { files: ['requested'], subject: 'feat: one' },
          { files: ['./requested'], subject: 'feat: two' },
        ],
      }),
    ).rejects.toThrow(/assigned.*multiple groups/i);
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it('reports earlier commits on cancellation without a second cleanup conflict', async () => {
    const directory = await fixture('');
    await writeFile(join(directory, 'other'), 'second change');
    const controller = new AbortController();
    let preparations = 0;
    let firstSha = '';
    const tool = createCommitTool({
      exec: async (command, arguments_, options) => {
        if (command === 'env' && arguments_.includes('node')) {
          preparations += 1;

          if (preparations === 2) {
            firstSha = (await git(directory, ['rev-parse', 'HEAD'])).trim();
            controller.abort();
          }
        }

        return runCommand(command, arguments_, options?.cwd ?? directory);
      },
    });
    const caught = await tool
      .execute(
        'batch',
        {
          groups: [
            { files: ['requested'], subject: 'feat: one' },
            { files: ['other'], subject: 'feat: two' },
          ],
        },
        controller.signal,
        undefined,
        commitContext(directory),
      )
      .catch((error: unknown) => {
        if (error instanceof Error) {
          return error;
        }

        throw error;
      });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(firstSha);
    expect((caught as Error).message).toContain('Commit cancelled');
    expect((caught as Error).message).not.toContain('ownership conflict');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('reports earlier commits when later cleanup encounters concurrent staging', async () => {
    const directory = await fixture('');
    await writeFile(join(directory, 'other'), 'second change');
    let reviews = 0;
    let firstSha = '';
    const tool = createReviewedCommitTool(
      {
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      },
      async () => {
        reviews += 1;
        if (reviews === 2) {
          firstSha = (await git(directory, ['rev-parse', 'HEAD'])).trim();
          await writeFile(join(directory, 'other'), 'concurrent staging');
          await git(directory, ['add', 'other']);
        }

        return { findings: [] };
      },
    );

    const caught = await tool
      .execute(
        'batch',
        {
          groups: [
            { files: ['requested'], subject: 'feat: one' },
            { files: ['other'], subject: 'feat: two' },
          ],
        },
        undefined,
        undefined,
        commitContext(directory),
      )
      .catch((error: unknown) => {
        if (error instanceof Error) {
          return error;
        }

        throw error;
      });

    expect((caught as Error).message).toMatch(
      /changed[\s\S]*ownership conflict[\s\S]*Already committed:[\s\S]*feat: one/,
    );
    expect(firstSha).toHaveLength(40);
    expect((caught as Error).message).toContain(firstSha);
    expect(await git(directory, ['show', ':other'])).toBe('concurrent staging');
  });

  it('returns cancellation and recovery after interrupting a real preparation process', async () => {
    const directory = await fixture(
      "require('node:fs').writeFileSync('requested', 'interrupted'); setInterval(() => {}, 1000)",
    );
    const originalIndex = await readFile(join(directory, '.git/index'));
    const controller = new AbortController();
    const tool = createCommitTool({
      exec: async (command, arguments_, options) => {
        const pending = runCommand(command, arguments_, options?.cwd ?? directory, options?.signal);

        if (command === 'env' && arguments_.includes('node')) {
          await vi.waitFor(async () =>
            readFile(join(directory, 'requested'), 'utf8').then((content) => {
              if (content !== 'interrupted') {
                throw new Error('Preparation has not started.');
              }
            }),
          );
          controller.abort();
        }

        return pending;
      },
    });
    const result = await tool.execute(
      'cancel',
      { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
      controller.signal,
      undefined,
      commitContext(directory),
    );

    expect(result.content).toContainEqual({ type: 'text', text: 'Commit cancelled' });
    expect(JSON.stringify(result.content)).toContain('Recovery saved');
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(
      Buffer.from((await recovery(directory)).working.requested!.content, 'base64').toString(),
    ).toBe('working');
  });

  it.each(['', "; require('node:child_process').execFileSync('git', ['add', 'generated'])"])(
    'stops unassigned generated additions before checks: %s',
    async (stage) => {
      const directory = await fixture(
        `require('node:fs').writeFileSync('generated', 'new bytes')${stage}`,
      );
      const originalIndex = await readFile(join(directory, '.git/index'));

      await expect(
        executeCommit(directory, {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        }),
      ).rejects.toThrow(/Preparation added paths.*generated.*Assign/s);
      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
      expect(await readFile(join(directory, 'generated'), 'utf8')).toBe('new bytes');
      const saved = await recovery(directory);
      expect(Buffer.from(saved.working['user data\n.txt']!.content, 'base64').toString()).toBe(
        'untracked prior bytes',
      );
    },
  );

  it.each(['other', 'user data\n.txt'])(
    'rejects unrequested worktree edits without absorbing them: %s',
    async (path) => {
      const directory = await fixture(
        `require('node:fs').writeFileSync(${JSON.stringify(path)}, 'formatter bytes')`,
      );
      const originalIndex = await readFile(join(directory, '.git/index'));

      await expect(
        executeCommit(directory, {
          groups: [
            { files: ['requested'], subject: 'feat: requested' },
            { files: ['other'], subject: 'feat: other' },
          ],
        }),
      ).rejects.toThrow(/ownership conflict/);
      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
      expect(await readFile(join(directory, path), 'utf8')).toBe('formatter bytes');
    },
  );

  it('recovers exact tracked and untracked bytes after a real process is killed', async () => {
    const directory = await fixture(
      `const fs = require('node:fs'); fs.writeFileSync('requested', 'damaged'); fs.unlinkSync('user data\\n.txt'); process.kill(process.pid, 'SIGKILL');`,
    );
    const originalIndex = await readFile(join(directory, '.git/index'));

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/preparation failed[\s\S]*Recovery saved/i);
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    const saved = await recovery(directory);
    expect(Buffer.from(saved.working.requested!.content, 'base64').toString()).toBe('working');
    expect(Buffer.from(saved.working['user data\n.txt']!.content, 'base64').toString()).toBe(
      'untracked prior bytes',
    );
    expect(await readFile(join(saved.path, 'original-index'))).toEqual(originalIndex);
    expect(await readFile(join(saved.path, 'recovery.txt'), 'utf8')).toContain('Never copy');
  });

  it('classifies clean tracked generated changes separately from user edits', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('other', 'generated bytes')");

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/Preparation added paths.*other.*Assign/s);
    await writeFile(join(directory, 'other'), 'user edit');

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/ownership conflict.*other/);
  });

  it('returns nested generated paths for explicit assignment in a new call', async () => {
    const directory = await fixture(
      `const fs = require('node:fs'); fs.writeFileSync('generated', 'new bytes'); fs.writeFileSync('other', 'generated tracked'); require('node:child_process').execFileSync('git', ['add', 'other']);`,
    );
    await git(directory, ['reset']);
    await writeRepositoryFile(directory, 'sub/requested', 'nested bytes');
    const config = JSON.parse(await readFile(join(directory, 'tau.json'), 'utf8')) as {
      prepare: string[];
      check?: string[];
    };
    config.check = [
      'node',
      '-e',
      `const fs = require('node:fs'); if (fs.readFileSync('generated', 'utf8') !== 'new bytes' || fs.readFileSync('other', 'utf8') !== 'generated tracked') process.exit(1)`,
    ];
    await writeFile(join(directory, 'tau.json'), JSON.stringify(config));
    await git(directory, ['add', 'tau.json']);
    await git(directory, ['commit', '-m', 'test: configure check']);
    const reviewer = vi.fn<typeof reviewComments>(async (_pi, _context, _signal, snapshot) => {
      expect(await git(directory, ['show', `${snapshot.tree}:generated`])).toBe('new bytes');
      expect(await git(directory, ['show', `${snapshot.tree}:other`])).toBe('generated tracked');

      return { findings: [] };
    });
    const tool = createReviewedCommitTool(
      {
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      },
      reviewer,
    );
    await expect(
      tool.execute(
        'nested',
        { groups: [{ files: ['requested'], subject: 'feat: nested' }] },
        undefined,
        undefined,
        commitContext(join(directory, 'sub')),
      ),
    ).rejects.toThrow(/Preparation added paths.*generated.*other.*Assign/s);
    expect(reviewer).not.toHaveBeenCalled();

    const result = await tool.execute(
      'retry',
      { groups: [{ files: ['sub/requested', 'generated', 'other'], subject: 'feat: nested' }] },
      undefined,
      undefined,
      commitContext(directory),
    );

    expect(result.details.groups[0]).toMatchObject({
      files: ['sub/requested', 'generated', 'other'],
      pathBase: 'repository',
    });
    expect(await git(directory, ['show', 'HEAD:generated'])).toBe('new bytes');
    expect(reviewer).toHaveBeenCalledTimes(1);
  });

  it('reserves accepted generated paths against later preparation in the batch', async () => {
    const directory = await fixture(
      `const fs = require('node:fs'); const cp = require('node:child_process'); const staged = cp.execFileSync('git', ['diff', '--cached', '--name-only']).toString(); fs.writeFileSync('generated', staged.includes('requested') ? 'first group' : 'second group');`,
    );
    await writeFile(join(directory, 'other'), 'second request');
    await writeFile(join(directory, 'generated'), 'first group');
    let preparations = 0;
    const reviewer = vi.fn<typeof reviewComments>(async () => ({ findings: [] }));
    const tool = createReviewedCommitTool(
      {
        exec: (command, arguments_, options) => {
          if (command === 'env' && arguments_.includes('node')) {
            preparations += 1;
          }

          return runCommand(command, arguments_, options?.cwd ?? directory);
        },
      },
      reviewer,
    );
    const result = await tool
      .execute(
        'batch',
        {
          groups: [
            { files: ['requested', 'generated'], subject: 'feat: first' },
            { files: ['other'], subject: 'feat: second' },
          ],
        },
        undefined,
        undefined,
        { cwd: directory, hasUI: true, ui: {} } as never,
      )
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(
      /ownership conflict.*generated[\s\S]*Already committed:[\s\S]*feat: first/,
    );
    expect((result as Error).message).toContain(
      (await git(directory, ['rev-parse', 'HEAD'])).trim(),
    );
    expect(await git(directory, ['show', 'HEAD:generated'])).toBe('first group');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    expect(preparations).toBe(2);
    expect(reviewer).toHaveBeenCalledTimes(1);
  });

  it('restores a nested prepared index when a hook stages a sibling path', async () => {
    const directory = await fixture('');
    await git(directory, ['reset']);
    await writeRepositoryFile(directory, 'sub/requested', 'nested');
    await writeFile(
      join(directory, '.git/hooks/pre-commit'),
      '#!/bin/sh\nprintf smuggled > sibling\ngit add sibling\n',
      { mode: 0o755 },
    );
    const originalIndex = await readFile(join(directory, '.git/index'));
    const previousHead = await git(directory, ['rev-parse', 'HEAD']);
    const tool = createCommitTool({
      exec: (command, arguments_, options) =>
        runCommand(command, arguments_, options?.cwd ?? directory),
    });
    const failure: unknown = await tool
      .execute(
        'hook',
        { groups: [{ files: ['requested'], subject: 'feat: nested' }] },
        undefined,
        undefined,
        {
          cwd: join(directory, 'sub'),
          hasUI: true,
          ui: {},
        } as never,
      )
      .catch((error: unknown) => error);

    expect(String(failure)).toMatch(/hook staged paths.*sibling.*undone/);
    expect(String(failure)).not.toContain('Index cleanup failed');
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(previousHead);
  });

  it('does not mislabel nested cancellation paths before group normalization', async () => {
    const directory = await fixture('');
    await git(directory, ['reset']);
    await writeRepositoryFile(directory, 'sub/requested', 'nested');
    const controller = new AbortController();
    const tool = createCommitTool({
      exec: async (command, arguments_, options) => {
        const result = await runCommand(command, arguments_, options?.cwd ?? directory);

        if (arguments_[0] === 'update-ref' && arguments_[1]?.startsWith('refs/tau/recovery/')) {
          controller.abort();
        }

        return result;
      },
    });
    const result = await tool.execute(
      'cancel',
      { groups: [{ files: ['requested'], subject: 'feat: nested' }] },
      controller.signal,
      undefined,
      commitContext(join(directory, 'sub')),
    );

    expect(result.details.groups[0]).toMatchObject({ sha: '', files: ['requested'] });
    expect(result.details.groups[0]).not.toHaveProperty('pathBase');
  });

  it('preserves concurrent staging immediately after publishing a prepared nested candidate', async () => {
    const directory = await fixture('');
    await git(directory, ['reset']);
    await writeRepositoryFile(directory, 'sub/requested', 'nested');
    const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await original.rename(source, destination);
      await writeFile(join(directory, 'sibling'), 'concurrent bytes');
      await git(directory, ['add', 'sibling']);
    });
    const tool = createCommitTool({
      exec: (command, arguments_, options) =>
        runCommand(command, arguments_, options?.cwd ?? directory),
    });

    try {
      await expect(
        tool.execute(
          'race',
          { groups: [{ files: ['requested'], subject: 'feat: nested' }] },
          undefined,
          undefined,
          {
            cwd: join(directory, 'sub'),
            hasUI: true,
            ui: {},
          } as never,
        ),
      ).rejects.toThrow(/Index ownership conflict/);
      expect(await git(directory, ['show', ':sibling'])).toBe('concurrent bytes');
    } finally {
      vi.mocked(rename).mockImplementation(original.rename);
    }
  });

  it.each(['.env', '.ssh/id_rsa', ':generated'])(
    'rejects guarded generated path %s before assignment',
    async (path) => {
      const directory = await fixture(
        `const fs = require('node:fs'); fs.mkdirSync('.ssh', { recursive: true }); fs.writeFileSync(${JSON.stringify(path)}, 'generated');`,
      );
      const originalIndex = await readFile(join(directory, '.git/index'));
      const custom = vi.fn<() => Promise<string>>(() => Promise.resolve('assign'));
      const tool = createCommitTool({
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      });

      await expect(
        tool.execute(
          'guard',
          { groups: [{ files: ['requested'], subject: 'feat: guarded' }] },
          undefined,
          undefined,
          { cwd: directory, hasUI: true, ui: { custom } } as never,
        ),
      ).rejects.toThrow(/Invalid path/);
      expect(custom).not.toHaveBeenCalled();
      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    },
  );

  it.each([true, false])(
    'stops unassigned additions without UI when hasUI is %s',
    async (hasUI) => {
      const directory = await fixture("require('node:fs').writeFileSync('generated', 'prepared')");
      const originalIndex = await readFile(join(directory, '.git/index'));
      const custom = vi.fn<() => Promise<string>>(() => Promise.resolve('assign'));
      const reviewer = vi.fn<typeof reviewComments>(() => Promise.resolve({ findings: [] }));
      const tool = createReviewedCommitTool(
        {
          exec: (command, arguments_, options) =>
            runCommand(command, arguments_, options?.cwd ?? directory),
        },
        reviewer,
      );

      await expect(
        tool.execute(
          'unassigned',
          { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
          undefined,
          undefined,
          { cwd: directory, hasUI, ui: { custom } } as never,
        ),
      ).rejects.toThrow(/Preparation added paths \(repository-relative\).*generated.*Assign/);
      expect(custom).not.toHaveBeenCalled();
      expect(reviewer).not.toHaveBeenCalled();
      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    },
  );

  it('reviews and commits each executed prepared batch candidate without speculative preparation', async () => {
    const directory = await fixture(
      `const fs = require('node:fs'); const cp = require('node:child_process'); const staged = cp.execFileSync('git', ['diff', '--cached', '--name-only']).toString(); fs.writeFileSync(staged.includes('requested') ? 'generated-one' : 'generated-two', 'prepared');`,
    );
    await writeFile(join(directory, 'other'), 'second request');
    await writeFile(join(directory, 'generated-one'), 'prepared');
    await writeFile(join(directory, 'generated-two'), 'prepared');
    const events: string[] = [];
    const reviewer = vi.fn<typeof reviewComments>(async (_pi, _context, _signal, snapshot) => {
      const diff = await git(directory, ['diff', '--name-only', snapshot.head!, snapshot.tree]);
      events.push(diff.includes('generated-one') ? 'review one' : 'review two');

      return { findings: [] };
    });
    const tool = createReviewedCommitTool(
      {
        exec: (command, arguments_, options) => {
          if (command === 'env' && arguments_.includes('node')) {
            events.push('prepare');
          }

          return runCommand(command, arguments_, options?.cwd ?? directory);
        },
      },
      reviewer,
    );
    const result = await tool.execute(
      'batch',
      {
        groups: [
          { files: ['requested', 'generated-one'], subject: 'feat: one' },
          { files: ['other', 'generated-two'], subject: 'feat: two' },
        ],
      },
      undefined,
      undefined,
      commitContext(directory),
    );

    expect(events).toEqual(['prepare', 'review one', 'prepare', 'review two']);
    expect(result.details.groups.map((group) => group.pathBase)).toEqual([
      'repository',
      'repository',
    ]);
  });

  it('rejects generated bytes changed after review and rechecks the new candidate on retry', async () => {
    const directory = await fixture(
      "const fs = require('node:fs'); if (!fs.existsSync('generated')) fs.writeFileSync('generated', 'prepared')",
    );
    const originalIndex = await readFile(join(directory, '.git/index'));
    await writeFile(join(directory, 'generated'), 'prepared');
    const reviewedBytes: string[] = [];
    const reviewer = vi.fn<typeof reviewComments>(async (_pi, _context, _signal, snapshot) => {
      reviewedBytes.push(await git(directory, ['show', `${snapshot.tree}:generated`]));
      if (reviewedBytes.length === 1) {
        await writeFile(join(directory, 'generated'), 'changed');
        await git(directory, ['add', 'generated']);
      }

      return { findings: [] };
    });
    const tool = createReviewedCommitTool(
      {
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      },
      reviewer,
    );

    await expect(
      tool.execute(
        'mutate',
        { groups: [{ files: ['requested', 'generated'], subject: 'feat: requested' }] },
        undefined,
        undefined,
        commitContext(directory),
      ),
    ).rejects.toThrow(/changed since comment review/);
    expect(await git(directory, ['show', ':generated'])).toBe('changed');
    await writeFile(join(directory, '.git/index'), originalIndex);
    const result = await tool.execute(
      'retry',
      { groups: [{ files: ['requested', 'generated'], subject: 'feat: requested' }] },
      undefined,
      undefined,
      commitContext(directory),
    );

    expect(reviewedBytes).toEqual(['prepared', 'changed']);
    expect(result.details.groups[0]?.sha).toBeTruthy();
  });

  it('retains the original index when the check rejects accepted generated bytes', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('generated', 'prepared')");
    const config = JSON.parse(await readFile(join(directory, 'tau.json'), 'utf8')) as {
      prepare: string[];
      check?: string[];
    };
    await writeFile(join(directory, 'generated'), 'prepared');
    config.check = ['sh', '-c', 'test ! -e generated'];
    await writeFile(join(directory, 'tau.json'), JSON.stringify(config));
    const originalIndex = await readFile(join(directory, '.git/index'));
    const reviewer = vi.fn<typeof reviewComments>(() => Promise.resolve({ findings: [] }));
    const tool = createReviewedCommitTool(
      {
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      },
      reviewer,
    );
    const custom = vi.fn<() => Promise<string>>(() => Promise.resolve('assign'));

    await expect(
      tool.execute(
        'check',
        { groups: [{ files: ['requested', 'generated', 'tau.json'], subject: 'feat: requested' }] },
        undefined,
        undefined,
        { cwd: directory, hasUI: true, ui: { custom } } as never,
      ),
    ).rejects.toThrow(/Project check failed[\s\S]*Recovery saved/);
    expect(custom).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
  });

  it('handles a requested new file deleted by preparation', async () => {
    const directory = await fixture(
      "require('node:fs').unlinkSync('new file'); require('node:child_process').execFileSync('git', ['add', '-A', '--', 'new file']);",
    );
    await writeFile(join(directory, 'new file'), 'new data');

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested', 'new file'], subject: 'feat: requested' }],
    });

    expect(result.details.groups[0]?.sha).toBeTruthy();
    expect(await git(directory, ['ls-tree', '--name-only', 'HEAD', '--', 'new file'])).toBe('');
  });

  it('uses literal root-relative paths from a nested cwd in a linked worktree', async () => {
    const directory = await fixture(
      `const fs = require('node:fs'); const cp = require('node:child_process'); for (const path of cp.execFileSync('git', ['diff', '--cached', '--name-only', '-z']).toString().split('\\0').filter(Boolean)) fs.writeFileSync(path, 'prepared literal');`,
    );
    const linked = join(directory, 'linked');
    await git(directory, ['worktree', 'add', '-b', 'linked', linked, 'HEAD']);
    const files = ['space name', 'line\nname', '[literal]', 'back\\slash', './:(literal)name'];

    for (const file of files) {
      await writeRepositoryFile(linked, `nested\nfolder/${file}`, 'new');
    }

    const result = await executeCommit(join(linked, 'nested\nfolder'), {
      groups: [{ files, subject: 'feat: literal paths' }],
    });

    expect(result.details.groups[0]?.sha).toBeTruthy();
    for (const file of files) {
      expect(await git(linked, ['show', `HEAD:nested\nfolder/${file.replace(/^\.\//, '')}`])).toBe(
        'prepared literal',
      );
    }

    const recoveryRoot = (
      await git(linked, ['rev-parse', '--path-format=absolute', '--git-path', 'tau-recovery'])
    ).trim();
    expect(recoveryRoot).toContain('/worktrees/linked/');
    expect(await readdir(recoveryRoot)).toEqual([]);
  });

  it('saves executable modes and symlink targets without following symlinks', async () => {
    const directory = await fixture(
      "const fs = require('node:fs'); fs.unlinkSync('link'); fs.chmodSync('other', 0o644); process.exit(1)",
    );
    await symlink('other', join(directory, 'link'));
    await chmod(join(directory, 'other'), 0o755);

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/Recovery saved/);
    const saved = await recovery(directory);

    expect(saved.working.other!.mode).toBe(0o755);
    expect(saved.working.link!.kind).toBe('symlink');
    expect(Buffer.from(saved.working.link!.content, 'base64').toString()).toBe('other');
  });

  it('rejects a symlink ancestor before running preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    await writeRepositoryFile(directory, 'folder/child', 'tracked');
    await git(directory, ['add', 'folder/child']);
    await rm(join(directory, 'folder'), { recursive: true });
    await mkdir(join(directory, 'elsewhere'));
    await symlink('elsewhere', join(directory, 'folder'));

    await expect(
      executeCommit(directory, {
        groups: [{ files: ['requested', 'folder/child'], subject: 'feat: requested' }],
      }),
    ).rejects.toThrow(/directory symlinks/);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'rejects unsupported index flags before running preparation: %s',
    async (flag) => {
      const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
      await git(directory, ['update-index', flag, 'other']);
      const originalIndex = await readFile(join(directory, '.git/index'));

      await expect(
        executeCommit(directory, {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        }),
      ).rejects.toThrow(/Unsupported index/);
      expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
      expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
    },
  );

  it('leaves unknown pre-staged files untouched without running preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    await writeFile(join(directory, 'other'), 'staged user content');
    await git(directory, ['add', 'other']);
    const originalIndex = await readFile(join(directory, '.git/index'));

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/already staged: other/);
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it('rejects submodules before preparation and keeps recovery objects reachable', async () => {
    const directory = await fixture('process.exit(1)');

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/Recovery saved/);
    const saved = await recovery(directory);
    const reference = (await readFile(join(saved.path, 'recovery-ref'), 'utf8')).trim();
    await git(directory, ['gc', '--prune=now']);
    expect(await git(directory, ['show', `${reference}:requested`])).toBe('staged');
    expect(await git(directory, ['stash', 'list'])).toBe('');

    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();
    await git(directory, ['update-index', '--add', '--cacheinfo', `160000,${head},submodule`]);
    const originalIndex = await readFile(join(directory, '.git/index'));

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/Unsupported index/);
    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
  });

  it('rejects a symlink index before snapshot or preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    const index = join(directory, '.git/index');
    const originalIndex = await readFile(index);
    await rename(index, `${index}-target`);
    await symlink('index-target', index);

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/regular index file/);
    expect(await readFile(index)).toEqual(originalIndex);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
    await expect(readdir(join(directory, '.git/tau-recovery'))).rejects.toThrow(/ENOENT/);
  });

  it('supports an existing staged-only requested deletion', async () => {
    const directory = await fixture('');
    await git(directory, ['rm', '-f', 'requested']);

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: delete requested' }],
    });

    expect(result.details.groups[0]?.sha).toBeTruthy();
    expect(await git(directory, ['ls-tree', '--name-only', 'HEAD', '--', 'requested'])).toBe('');
  });

  it('rejects directory requests before running preparation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'mutated')");
    await writeRepositoryFile(directory, 'folder/child', 'child');

    await expect(
      executeCommit(directory, {
        groups: [{ files: ['requested', 'folder'], subject: 'feat: folder' }],
      }),
    ).rejects.toThrow(/individual files.*directory/i);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it('restages requested deletions after preparation', async () => {
    const directory = await fixture('');

    await rm(join(directory, 'requested'));
    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: delete requested' }],
    });

    expect(result.details.groups[0]?.sha).toBeTruthy();
    expect(await git(directory, ['ls-tree', '--name-only', 'HEAD', '--', 'requested'])).toBe('');
  });

  it('preserves prior staging and current user edits on cancellation', async () => {
    const directory = await fixture("require('node:fs').writeFileSync('requested', 'formatted')");
    const originalIndex = await readFile(join(directory, '.git/index'));
    const controller = new AbortController();
    const tool = createReviewedCommitTool(
      {
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      },
      async () => {
        await writeFile(join(directory, 'requested'), 'concurrent working edit');
        controller.abort();

        return { findings: [] };
      },
    );
    const call = tool.execute(
      'cleanup',
      { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
      controller.signal,
      undefined,
      commitContext(directory),
    );

    const outcome = await call.then(
      (result) => JSON.stringify(result.content),
      (error: unknown) => String(error),
    );

    expect(outcome).toContain('Commit cancelled');
    expect(outcome).toContain('Recovery saved');

    expect(await readFile(join(directory, '.git/index'))).toEqual(originalIndex);
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('concurrent working edit');
    expect((await recovery(directory)).working.requested).not.toBeNull();
  });
});
