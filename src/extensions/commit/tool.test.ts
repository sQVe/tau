import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commentPolicyHash, reviewGit } from './commentReview.js';
import type { CommentReview, reviewComments } from './commentReview.js';
import type { CommitInput } from './tool.js';
import {
  commitFailedError,
  createCommitTool as createReviewedCommitTool,
  validatePaths,
  validateSubject,
} from './tool.js';

// Git and approval tests use a clean reviewer; model review is exercised through real Pi below.
const createCommitTool = (pi: Pick<ExtensionAPI, 'exec'>) =>
  createReviewedCommitTool(pi, async () => ({ findings: [] }));

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runCommand = async (
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd });
    return { stdout, stderr, code: 0, killed: false };
  } catch (error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };

    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      code: failure.code ?? 1,
      killed: failure.killed ?? false,
    };
  }
};

const git = async (repoDir: string, args: string[]): Promise<string> => {
  const result = await runCommand('git', args, repoDir);

  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
};

const createTempRepo = async (): Promise<string> => {
  const repoDir = await mkdtemp(join(tmpdir(), 'tau-commit-'));
  tempDirs.push(repoDir);

  await git(repoDir, ['init']);
  await git(repoDir, ['config', 'user.name', 'Tau Test']);
  await git(repoDir, ['config', 'user.email', 'tau@example.com']);
  await git(repoDir, ['config', 'commit.gpgsign', 'false']);

  return repoDir;
};

const writeRepoFile = async (
  repoDir: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const fullPath = join(repoDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
};

const getStoredCommitMessage = async (repoDir: string): Promise<string> => {
  const commitObject = await git(repoDir, ['cat-file', '-p', 'HEAD']);
  const separatorIndex = commitObject.indexOf('\n\n');

  if (separatorIndex === -1) {
    throw new Error('Could not locate commit message in git cat-file output');
  }

  return commitObject.slice(separatorIndex + 2);
};

const confirmedContext = (repoDir: string) =>
  ({
    cwd: repoDir,
    hasUI: true,
    ui: { custom: () => Promise.resolve('approve') },
  }) as never;

const declinedContext = (repoDir: string) =>
  ({
    cwd: repoDir,
    hasUI: true,
    ui: { custom: () => Promise.resolve('abort') },
  }) as never;

const noUiContext = (repoDir: string) =>
  ({
    cwd: repoDir,
    hasUI: false,
    ui: {},
  }) as never;

const executeCommit = async (repoDir: string, input: CommitInput) => {
  const commitTool = createCommitTool({
    exec(command: string, args: string[], options?: { cwd?: string }) {
      return runCommand(command, args, options?.cwd ?? repoDir);
    },
  });

  return commitTool.execute('tool-call-1', input, undefined, undefined, confirmedContext(repoDir));
};

describe('reviewGit', () => {
  it('identifies the failing command after global Git options', async () => {
    const repoDir = await createTempRepo();
    await expect(
      reviewGit(
        { exec: (command, args, options) => runCommand(command, args, options?.cwd ?? repoDir) },
        repoDir,
        ['--literal-pathspecs', 'ls-tree', 'missing-tree'],
      ),
    ).rejects.toThrow('git --literal-pathspecs ls-tree missing-tree failed');
  });
});

describe('validateSubject', () => {
  it('throws a validation error naming the subject when it is not a conventional commit', () => {
    const subject = 'Add stuff.';

    expect(() => {
      validateSubject(subject);
    }).toThrow(new RegExp(`subject.*${subject.replace('.', '\\.')}`, 'i'));
  });

  it('returns without throwing when the subject is a conventional commit', () => {
    expect(() => {
      validateSubject('feat: add thing');
    }).not.toThrow();
    expect(() => {
      validateSubject('fix(scope): do it');
    }).not.toThrow();
    expect(() => {
      validateSubject('chore!: breaking');
    }).not.toThrow();
  });
});

describe('validatePaths', () => {
  it('throws an error naming the offending path when any file matches the sensitive denylist', () => {
    expect(() => {
      validatePaths(['.env']);
    }).toThrow(/\.env/);
    expect(() => {
      validatePaths(['db/credentials.json']);
    }).toThrow(/db\/credentials\.json/);
    expect(() => {
      validatePaths(['keys/id_rsa']);
    }).toThrow(/keys\/id_rsa/);
    expect(() => {
      validatePaths(['.ssh/config']);
    }).toThrow(/\.ssh\/config/);
  });

  it('rejects paths with leading dot-slash that would bypass anchored patterns', () => {
    expect(() => {
      validatePaths(['./.env']);
    }).toThrow(/\.env/);
  });

  it('rejects sensitive paths that redundant separators would otherwise hide', () => {
    expect(() => {
      validatePaths(['.//id_rsa']);
    }).toThrow(/id_rsa/);
    expect(() => {
      validatePaths(['./././id_rsa']);
    }).toThrow(/id_rsa/);
  });

  it('rejects sensitive files in subdirectories, not just at the repository root', () => {
    expect(() => {
      validatePaths(['config/.env']);
    }).toThrow(/config\/\.env/);
    expect(() => {
      validatePaths(['packages/app/.npmrc']);
    }).toThrow(/\.npmrc/);
    expect(() => {
      validatePaths(['home/.ssh/config']);
    }).toThrow(/\.ssh/);
  });

  it('rejects sensitive paths whose casing differs from the pattern', () => {
    expect(() => {
      validatePaths(['.ENV']);
    }).toThrow(/\.ENV/);
    expect(() => {
      validatePaths(['.Env.production']);
    }).toThrow(/\.Env\.production/);
  });

  it('rejects paths that resolve to the repository root', () => {
    for (const pathspec of ['./', '.', './.', 'src/..']) {
      expect(() => {
        validatePaths([pathspec]);
      }).toThrow(/Invalid path/);
    }
  });

  it('rejects an .ssh directory named without a trailing slash', () => {
    expect(() => {
      validatePaths(['.ssh']);
    }).toThrow(/\.ssh/);
    expect(() => {
      validatePaths(['home/.ssh']);
    }).toThrow(/\.ssh/);
  });

  it('accepts filenames containing glob characters, which git takes literally', () => {
    expect(() => {
      validatePaths(['app/[slug]/page.tsx', 'docs/faq?.md']);
    }).not.toThrow();
  });

  it('rejects pathspec magic and traversal attempts', () => {
    expect(() => {
      validatePaths([':(glob)*.ts']);
    }).toThrow(/Invalid path/);
    expect(() => {
      validatePaths(['../etc/passwd']);
    }).toThrow(/Invalid path/);
    expect(() => {
      validatePaths(['/etc/passwd']);
    }).toThrow(/Invalid path/);
  });

  it('rejects traversal that only escapes the repository once collapsed', () => {
    expect(() => {
      validatePaths(['src/../../etc/passwd']);
    }).toThrow(/Invalid path/);
    expect(() => {
      validatePaths(['src/..']);
    }).toThrow(/Invalid path/);
  });

  it('returns without throwing when all files are outside the sensitive denylist', () => {
    expect(() => {
      validatePaths(['src/foo.ts', 'README.md', 'docs/env.md']);
    }).not.toThrow();
  });
});

describe('commitTool.execute', () => {
  it.each(['approve', 'skip'])(
    'processes three groups sequentially with %s in the middle',
    async (middle) => {
      const repoDir = await createTempRepo();
      const groups = ['one', 'two', 'three'].map((name) => ({
        files: [`${name}.txt`],
        subject: `feat: add ${name}`,
      }));
      for (const group of groups) await writeRepoFile(repoDir, group.files[0]!, group.subject);
      const heads: (string | null)[] = [];
      const trees: string[][] = [];
      const review: typeof reviewComments = async (_pi, _ctx, _signal, snapshot) => {
        heads.push(snapshot.head);
        trees.push(
          (await git(repoDir, ['ls-tree', '--name-only', snapshot.tree])).trim().split('\n'),
        );
        return { findings: [] };
      };
      const tool = createReviewedCommitTool(
        { exec: (command, args, options) => runCommand(command, args, options?.cwd ?? repoDir) },
        review,
      );
      const { ctx, previews } = fakeCommit(['approve', middle, 'approve']);
      ctx.cwd = repoDir;
      const result = await tool.execute('batch', { groups }, undefined, undefined, ctx as never);
      const shas = (await git(repoDir, ['log', '--reverse', '--format=%H'])).trim().split('\n');
      expect(shas).toHaveLength(middle === 'skip' ? 2 : 3);
      expect((await git(repoDir, ['log', '--reverse', '--format=%s'])).trim().split('\n')).toEqual(
        groups.filter((_, index) => middle !== 'skip' || index !== 1).map((group) => group.subject),
      );
      expect(result.details.groups.map((group) => group.sha).filter(Boolean)).toEqual(shas);
      for (const sha of shas) expect(JSON.stringify(result.content)).toContain(sha);
      expect(result.details.groups[1]?.skipped).toBe(middle === 'skip' ? true : undefined);
      expect(JSON.stringify(result.content).includes('Group 2/3: Commit skipped')).toBe(
        middle === 'skip',
      );
      expect(heads).toEqual([null, shas[0], middle === 'skip' ? shas[0] : shas[1]]);
      expect(trees).toEqual([
        ['one.txt'],
        ['one.txt', 'two.txt'],
        middle === 'skip' ? ['one.txt', 'three.txt'] : ['one.txt', 'three.txt', 'two.txt'],
      ]);
      expect(previews.map((preview, index) => preview.includes(`commit ${index + 1}/3`))).toEqual([
        true,
        true,
        true,
      ]);
      expect(await git(repoDir, ['diff', '--cached', '--name-only'])).toBe('');
    },
  );

  it.each([
    { files: ['two.txt'], subject: 'invalid' },
    { files: ['.env'], subject: 'feat: add two' },
  ])('validates all groups before staging: %j', async (invalid) => {
    const { input, execute, exec } = fakeCommit(['approve', 'approve']);
    input.groups.push({ ...invalid, body: '' });
    await expect(execute()).rejects.toThrow(/Invalid/);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['abort', 'cancel', 'corrections', 'retry', 'hook'])(
    'stops on %s and names earlier commits',
    async (failure) => {
      const repoDir = await createTempRepo();
      const groups = ['one', 'two', 'three', 'four'].map((name) => ({
        files: [`${name}.txt`],
        subject: `feat: add ${name}`,
      }));
      for (const group of groups) await writeRepoFile(repoDir, group.files[0]!, group.subject);
      const controller = new AbortController();
      let reviews = 0;
      const review = async () => {
        reviews += 1;
        if (reviews === 3 && failure === 'corrections')
          return {
            findings: [
              { path: 'three.txt', line: 1, kind: 'policy' as const, message: 'Fix comment.' },
            ],
          };
        if (reviews === 3 && failure === 'retry') throw new Error('Reviewer unavailable');
        return { findings: [] };
      };
      let overlays = 0;
      const ctx = {
        cwd: repoDir,
        hasUI: true,
        ui: {
          custom: async () => {
            overlays += 1;
            if (overlays <= 2) return 'approve';
            if (failure === 'cancel') controller.abort();
            if (failure === 'hook') {
              await writeRepoFile(
                repoDir,
                '.git/hooks/pre-commit',
                '#!/bin/sh\necho hook said no >&2\nexit 1\n',
              );
              await chmod(join(repoDir, '.git/hooks/pre-commit'), 0o755);
              return 'approve';
            }
            return failure === 'retry' ? 'retry' : 'abort';
          },
        },
      };
      const tool = createReviewedCommitTool(
        { exec: (command, args, options) => runCommand(command, args, options?.cwd ?? repoDir) },
        review,
      );
      const failureError = await tool
        .execute('batch', { groups }, controller.signal, undefined, ctx as never)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const shas = (await git(repoDir, ['log', '--reverse', '--format=%H'])).trim().split('\n');
      expect(failureError).toBeInstanceOf(Error);
      expect(shas).toHaveLength(2);
      for (const [index, sha] of shas.entries())
        expect((failureError as Error).message).toContain(`Group ${index + 1}/4: ${sha}`);
      expect((failureError as Error).message).toContain('Group 3/4');
      expect((failureError as Error).message).toContain(
        {
          abort: 'declined',
          cancel: 'cancelled',
          corrections: '1/2 automatic returns',
          retry: 'User requested fixes',
          hook: 'hook said no',
        }[failure]!,
      );
      expect((await git(repoDir, ['rev-list', '--all', '--count'])).trim()).toBe('2');
      expect(reviews).toBe(3);
      expect(await git(repoDir, ['diff', '--cached', '--name-only'])).toBe(
        failure === 'hook' ? 'three.txt\n' : '',
      );
    },
  );

  it('undoes a commit when a hook changes reviewed content in an approved file', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'retry.ts', 'export const retries = 0;\n');
    const hookPath = join(repoDir, '.git/hooks/pre-commit');
    await writeFile(
      hookPath,
      '#!/bin/sh\nprintf "// Unreviewed comment\\n" >> retry.ts\ngit add retry.ts\n',
    );
    await chmod(hookPath, 0o755);
    await expect(
      executeCommit(repoDir, { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] }),
    ).rejects.toThrow(/changed reviewed content/);
    expect((await git(repoDir, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });
  it('rejects staged content changed while commit approval is open', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'retry.ts', 'export const retries = 0;\n');
    const tool = createCommitTool({
      exec: (command, args, options) => runCommand(command, args, options?.cwd ?? repoDir),
    });
    const ctx = {
      cwd: repoDir,
      hasUI: true,
      ui: {
        custom: async () => {
          await writeRepoFile(
            repoDir,
            'retry.ts',
            '// Unreviewed comment\nexport const retries = 1;\n',
          );
          await git(repoDir, ['add', 'retry.ts']);
          return 'approve';
        },
      },
    } as never;
    await expect(
      tool.execute(
        'changed',
        { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/changed since comment review/);
    expect((await git(repoDir, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });

  it('expires old abandoned review groups', async () => {
    const repoDir = await createTempRepo();
    const review = vi.fn<() => Promise<CommentReview>>(async () => ({
      findings: [{ path: 'retry.ts', line: 1, kind: 'policy' as const, message: 'Stale comment.' }],
    }));
    const tool = createReviewedCommitTool(
      { exec: (command, args, options) => runCommand(command, args, options?.cwd ?? repoDir) },
      review,
    );
    const call = (path: string) =>
      tool.execute(
        'test',
        { groups: [{ files: [path], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        confirmedContext(repoDir),
      );
    for (let index = 0; index < 33; index += 1) {
      const path = `retry${index}.ts`;
      await writeRepoFile(repoDir, path, '// stale\n');
      await expect(call(path)).rejects.toThrow('1/2 automatic returns');
    }
    await expect(call('retry0.ts')).rejects.toThrow('1/2 automatic returns');
    expect(review).toHaveBeenCalledTimes(34);
  });
  it.each(['skip', 'abort', 'cancel'])('resets correction attempts after %s', async (choice) => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'retry.ts', '// stale\nexport const retries = 0;\n');
    const review = vi.fn<() => Promise<CommentReview>>(async () => ({
      findings: [
        { path: 'retry.ts', line: 1, kind: 'inaccurate' as const, message: 'Stale comment.' },
      ],
    }));
    const tool = createReviewedCommitTool(
      { exec: (command, args, options) => runCommand(command, args, options?.cwd ?? repoDir) },
      review,
    );
    const controller = new AbortController();
    const ctx = {
      cwd: repoDir,
      hasUI: true,
      ui: {
        custom: async () => {
          if (choice === 'cancel') controller.abort();
          return choice;
        },
      },
    } as unknown as ExtensionContext;
    const call = () =>
      tool.execute(
        'test',
        { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        ctx,
      );
    await expect(call()).rejects.toThrow('1/2 automatic returns');
    await expect(call()).rejects.toThrow('2/2 automatic returns');
    const finish = tool.execute(
      'test',
      { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
      controller.signal,
      undefined,
      ctx,
    );
    const outcome = await finish.then(
      () => 'returned',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome).toBe(choice === 'abort' ? 'Commit declined by user' : 'returned');
    await expect(call()).rejects.toThrow('1/2 automatic returns');
    expect(review).toHaveBeenCalledTimes(2);
  });
  it('throws and unstages when the user aborts the overlay', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');

    const commitTool = createCommitTool({
      exec(command: string, args: string[], options?: { cwd?: string }) {
        return runCommand(command, args, options?.cwd ?? repoDir);
      },
    });

    await expect(
      commitTool.execute(
        'tool-call-1',
        { groups: [{ files: ['README.md'], subject: 'feat: add thing' }] },
        undefined,
        undefined,
        declinedContext(repoDir),
      ),
    ).rejects.toThrow(/declined/i);

    expect(await git(repoDir, ['diff', '--cached', '--name-only'])).toBe('');

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('throws in non-interactive mode without attempting to commit', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');

    const commitTool = createCommitTool({
      exec(command: string, args: string[], options?: { cwd?: string }) {
        return runCommand(command, args, options?.cwd ?? repoDir);
      },
    });

    await expect(
      commitTool.execute(
        'tool-call-1',
        { groups: [{ files: ['README.md'], subject: 'feat: add thing' }] },
        undefined,
        undefined,
        noUiContext(repoDir),
      ),
    ).rejects.toThrow(/non-interactive/i);

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('creates exactly one commit in a temp git repo and returns the HEAD sha in details', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');

    const result = await executeCommit(repoDir, {
      groups: [
        {
          files: ['README.md'],
          subject: 'feat: add thing',
          body: 'Initial project file.',
        },
      ],
    });

    const shaOutput = await git(repoDir, ['rev-parse', 'HEAD']);
    const logOutput = await git(repoDir, ['log', '--oneline']);
    const latestSubjectOutput = await git(repoDir, ['log', '-1', '--format=%s']);

    const sha = shaOutput.trim();
    const logLines = logOutput.trim().split('\n');
    const latestSubject = latestSubjectOutput.trim();

    expect(logLines).toHaveLength(1);
    expect(latestSubject).toBe('feat: add thing');
    expect(result.details.groups[0]).toEqual({
      sha,
      files: ['README.md'],
      subject: 'feat: add thing',
      body: 'Initial project file.',
      commentReview: {
        status: 'passed',
        tree: (await git(repoDir, ['rev-parse', 'HEAD^{tree}'])).trim(),
        policy: commentPolicyHash,
        report: '',
      },
    });
    expect(result.content).toEqual([{ type: 'text', text: `${sha} feat: add thing` }]);
  });

  it('includes the body in the committed message when body is provided', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');

    await executeCommit(repoDir, {
      groups: [
        {
          files: ['README.md'],
          subject: 'feat: add',
          body: 'Longer explanation here.',
        },
      ],
    });

    const body = await getStoredCommitMessage(repoDir);
    expect(body).toBe('feat: add\n\nLonger explanation here.\n');
  });

  it('refuses to commit when unrelated paths are already staged', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');
    await writeRepoFile(repoDir, 'notes.md', 'keep staged\n');
    await git(repoDir, ['add', '--', 'notes.md']);

    await expect(
      executeCommit(repoDir, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: notes\.md/i);

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('refuses to commit a glob, because git matches the pattern literally', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'src/a.ts', 'export const a = 1;\n');

    await expect(
      executeCommit(repoDir, {
        groups: [
          {
            files: ['*'],
            subject: 'feat: add everything',
          },
        ],
      }),
    ).rejects.toThrow(/git add failed/i);

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('commits when the working directory is a subdirectory of the repository', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'sub/a.txt', 'hello\n');

    const commitTool = createCommitTool({
      exec(command: string, args: string[], options?: { cwd?: string }) {
        return runCommand(command, args, options?.cwd ?? repoDir);
      },
    });

    await commitTool.execute(
      'tool-call-1',
      { groups: [{ files: ['a.txt'], subject: 'feat: add a' }] },
      undefined,
      undefined,
      confirmedContext(join(repoDir, 'sub')),
    );

    expect((await git(repoDir, ['rev-list', '--all', '--count'])).trim()).toBe('1');
    expect((await git(repoDir, ['show', '--name-only', '--format=', 'HEAD'])).trim()).toBe(
      'sub/a.txt',
    );
  });

  it('restores the index when staging pulls in files alongside a requested one', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'src/a.ts', 'export const a = 1;\n');
    await writeRepoFile(repoDir, 'src/b.ts', 'export const b = 2;\n');

    await expect(
      executeCommit(repoDir, {
        groups: [
          {
            files: ['src/a.ts', 'src'],
            subject: 'feat: add sources',
          },
        ],
      }),
    ).rejects.toThrow(/staged paths that were not requested/i);

    expect(await git(repoDir, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('refuses to commit when staging a named path pulls in files it did not name', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'src/a.ts', 'export const a = 1;\n');
    await writeRepoFile(repoDir, 'src/b.ts', 'export const b = 2;\n');

    await expect(
      executeCommit(repoDir, {
        groups: [
          {
            files: ['src'],
            subject: 'feat: add sources',
          },
        ],
      }),
    ).rejects.toThrow(/staged paths that were not requested/i);

    expect(await git(repoDir, ['diff', '--cached', '--name-only'])).toBe('');

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('refuses to commit when an unrelated staged type change exists', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');
    await writeRepoFile(repoDir, 'link.txt', 'plain\n');
    await git(repoDir, ['add', '--', 'README.md', 'link.txt']);
    await git(repoDir, ['commit', '-m', 'initial']);

    await rm(join(repoDir, 'link.txt'));
    await symlink('/etc/hostname', join(repoDir, 'link.txt'));
    await git(repoDir, ['add', '--', 'link.txt']);

    await writeRepoFile(repoDir, 'README.md', 'updated\n');

    await expect(
      executeCommit(repoDir, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: update readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: link\.txt/i);
  });

  it('refuses to commit when an unrelated staged deletion exists', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');
    await writeRepoFile(repoDir, 'old.md', 'gone\n');
    await git(repoDir, ['add', '--', 'README.md', 'old.md']);
    await git(repoDir, ['commit', '-m', 'initial']);
    await git(repoDir, ['rm', '--', 'old.md']);

    await writeRepoFile(repoDir, 'README.md', 'updated\n');

    await expect(
      executeCommit(repoDir, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: update readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: old\.md/i);
  });

  it('requires another review after a formatting hook rewrites files, then commits cleanly', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');
    await writeRepoFile(
      repoDir,
      '.git/hooks/pre-commit',
      '#!/bin/sh\nprintf "formatted\\n" > README.md\ngit add -- README.md\n',
    );
    await chmod(join(repoDir, '.git/hooks/pre-commit'), 0o755);

    await expect(
      executeCommit(repoDir, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/changed reviewed content/);
    expect(await git(repoDir, ['show', ':README.md'])).toBe('formatted\n');
    await executeCommit(repoDir, {
      groups: [{ files: ['README.md'], subject: 'feat: add readme' }],
    });

    const statusOutput = await git(repoDir, ['status', '--short']);
    const committedContent = await git(repoDir, ['show', 'HEAD:README.md']);

    expect(statusOutput).toBe('');
    expect(committedContent).toBe('formatted\n');
  });

  it('undoes the commit when a hook stages paths behind the tool', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');
    await writeRepoFile(repoDir, 'sneaky.txt', 'not requested\n');
    await writeRepoFile(repoDir, '.git/hooks/pre-commit', '#!/bin/sh\ngit add -- sneaky.txt\n');
    await chmod(join(repoDir, '.git/hooks/pre-commit'), 0o755);

    await expect(
      executeCommit(repoDir, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/hook staged paths that were not requested: sneaky\.txt/i);

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
    expect(await git(repoDir, ['diff', '--cached', '--name-only'])).toBe('README.md\n');
  });

  it('undoes only the new commit when a hook smuggles a path into a later one', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'base.txt', 'base\n');
    await git(repoDir, ['add', '--', 'base.txt']);
    await git(repoDir, ['commit', '-m', 'chore: base']);
    const baseSha = (await git(repoDir, ['rev-parse', 'HEAD'])).trim();

    await writeRepoFile(repoDir, 'README.md', 'hello\n');
    await writeRepoFile(repoDir, 'sneaky.txt', 'not requested\n');
    await writeRepoFile(repoDir, '.git/hooks/pre-commit', '#!/bin/sh\ngit add -- sneaky.txt\n');
    await chmod(join(repoDir, '.git/hooks/pre-commit'), 0o755);

    await expect(
      executeCommit(repoDir, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/hook staged paths that were not requested/i);

    expect((await git(repoDir, ['rev-parse', 'HEAD'])).trim()).toBe(baseSha);
  });

  it('throws structured hook failure details and leaves the temp repo with zero commits when git commit fails', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');
    await writeRepoFile(
      repoDir,
      '.git/hooks/pre-commit',
      '#!/bin/sh\necho hook output\necho hook said no >&2\nexit 1\n',
    );
    await chmod(join(repoDir, '.git/hooks/pre-commit'), 0o755);

    let thrown: unknown;
    try {
      await executeCommit(repoDir, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add',
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('git commit failed:');
    expect((thrown as Error).message).toContain('hook said no');

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
  }, 10_000);

  it('falls back to stdout in the error message when stderr is only whitespace', () => {
    expect(commitFailedError('hook output\n', '   \n').message).toBe(
      'git commit failed: hook output',
    );
  });

  it('keeps both streams in the error message when a hook writes to each', () => {
    const message = commitFailedError('lint failed on src/a.ts\n', 'warning: slow hook\n').message;

    expect(message).toContain('lint failed on src/a.ts');
    expect(message).toContain('warning: slow hook');
  });
});

const fakeCommit = (choices: (string | undefined)[], edits: (string | undefined)[] = []) => {
  const previews: string[] = [];
  const custom = vi.fn<
    (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => Promise<string | undefined>
  >(async (factory) => {
    const component = await factory(
      { requestRender: () => {}, terminal: { rows: 60 } } as never,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
      {} as never,
      () => {},
    );
    previews.push(component.render(80).join('\n'));
    return choices.shift();
  });
  const editor = vi.fn<ExtensionContext['ui']['editor']>(() => Promise.resolve(edits.shift()));
  const exec = vi.fn<ExtensionAPI['exec']>((_command, args) => {
    let stdout = '';
    if (args.includes('--numstat')) stdout = '2\t1\tREADME.md\0-\t-\timage.png\0';
    if (args[0] === 'rev-parse' || args[0] === 'write-tree') stdout = 'abc123\n';
    return Promise.resolve({ code: 0, killed: false, stderr: '', stdout });
  });
  const tool = createCommitTool({ exec });
  const ctx = { cwd: '/repo', hasUI: true, ui: { custom, editor } };
  const input = {
    groups: [
      {
        files: ['README.md'],
        subject: 'feat: add thing',
        body: 'Original body',
      },
    ],
  };
  const execute = (signal?: AbortSignal) =>
    tool.execute('call', input, signal, undefined, ctx as never);
  return { custom, editor, exec, ctx, input, execute, previews };
};

describe('commit overlay flow', () => {
  it('stages and reads numstat before showing the overlay', async () => {
    const { execute, exec, custom, previews } = fakeCommit(['approve']);
    await execute();
    expect(previews[0]).toContain('commit 1/1');
    expect(previews[0]).toContain('README.md +2 -1');
    expect(previews[0]).toContain('image.png binary');
    expect(exec.mock.calls.slice(0, 4).map((call) => call[1])).toEqual([
      ['rev-parse', '--show-prefix'],
      ['diff', '--cached', '--name-only', '--diff-filter=ACMRDT', '-z'],
      ['--literal-pathspecs', 'add', '--', 'README.md'],
      ['diff', '--cached', '--name-only', '--diff-filter=ACMRDT', '-z'],
    ]);
    const numstatCall = exec.mock.calls.findIndex((call) => call[1].includes('--numstat'));
    expect(numstatCall).toBeGreaterThan(2);
    expect(exec.mock.invocationCallOrder[numstatCall]).toBeLessThan(
      custom.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('commits subject and body edits and returns the edited details', async () => {
    const { execute, editor, exec, custom } = fakeCommit(
      ['subject', 'body', 'approve'],
      ['fix: edited', 'Edited body'],
    );
    const result = await execute();
    expect(editor.mock.calls).toEqual([
      ['Edit subject', 'feat: add thing'],
      ['Edit body', 'Original body'],
    ]);
    expect(custom).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenCalledWith('git', ['commit', '-m', 'fix: edited\n\nEdited body'], {
      cwd: '/repo',
    });
    expect(result.details.groups[0]).toMatchObject({ subject: 'fix: edited', body: 'Edited body' });
  });

  it('retains the subject when the edit is cancelled', async () => {
    const { execute, custom, previews } = fakeCommit(['subject', 'approve'], [undefined]);

    const result = await execute();

    expect(result.details.groups[0]!.subject).toBe('feat: add thing');
    expect(previews[1]).not.toContain('Invalid subject');
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it('retains the subject and shows a notice when the edit is invalid', async () => {
    const { execute, custom, previews } = fakeCommit(['subject', 'approve'], ['not conventional']);

    const result = await execute();

    expect(result.details.groups[0]!.subject).toBe('feat: add thing');
    expect(previews[1]).toContain('Invalid subject: not conventional');
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, ''])('handles a cancelled or empty body edit: %s', async (edit) => {
    const { execute } = fakeCommit(['body', 'approve'], [edit]);
    const result = await execute();
    expect(result.details.groups[0]!.body).toBe(edit ?? 'Original body');
  });

  it('opens the body editor with an empty prefill when no body was supplied', async () => {
    const { execute, input, editor } = fakeCommit(['body', 'approve'], [undefined]);
    Reflect.deleteProperty(input.groups[0]!, 'body');
    const result = await execute();
    expect(editor).toHaveBeenCalledWith('Edit body', '');
    expect(result.details.groups[0]!.body).toBeNull();
  });

  it('unstages skipped groups and returns without committing', async () => {
    const { execute, exec } = fakeCommit(['skip']);
    const result = await execute();
    expect(result.content).toEqual([{ type: 'text', text: 'Commit skipped by user' }]);
    expect(result.details.groups[0]!.skipped).toBe(true);
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });

  it.each(['abort', undefined])('unstages and throws on abort or dismissal: %s', async (choice) => {
    const { execute, exec } = fakeCommit([choice]);
    await expect(execute()).rejects.toThrow('Commit declined by user');
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });

  it('rejects headless calls before staging', async () => {
    const { execute, exec, ctx, custom } = fakeCommit(['approve']);
    ctx.hasUI = false;
    await expect(execute()).rejects.toThrow(
      'Cannot commit without user confirmation (non-interactive mode)',
    );
    expect(exec).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });

  it('returns without UI or git operations when already cancelled', async () => {
    const { execute, exec, custom } = fakeCommit(['approve']);
    await execute(AbortSignal.abort());
    expect(exec).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });

  it('returns cancelled and unstages when aborted while the overlay is open', async () => {
    const controller = new AbortController();
    const { execute, exec, custom } = fakeCommit([]);
    custom.mockImplementation(
      (factory) =>
        new Promise<string | undefined>((resolve) => {
          void factory(
            { requestRender: () => {}, terminal: { rows: 60 } } as never,
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
            {} as never,
            (result: unknown) => {
              resolve(typeof result === 'string' ? result : undefined);
            },
          );
          controller.abort();
        }),
    );

    const result = await execute(controller.signal);

    expect(result.content[0]).toEqual({ type: 'text', text: 'Commit cancelled' });
    expect(exec).toHaveBeenCalledWith('git', ['--literal-pathspecs', 'reset', '--', 'README.md'], {
      cwd: '/repo',
    });
    expect(exec).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['commit']),
      expect.anything(),
    );
  });

  it('unstages without opening UI if cancelled while staging', async () => {
    const controller = new AbortController();
    const { execute, exec, custom } = fakeCommit(['approve']);
    exec.mockImplementation((_command, args) => {
      if (args.includes('add')) controller.abort();
      return Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' });
    });
    await execute(controller.signal);
    expect(custom).not.toHaveBeenCalled();
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });
});
