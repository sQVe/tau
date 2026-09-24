import { chmod, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createCommitTool,
  runCommand,
  git,
  createTemporaryRepository,
  writeRepositoryFile,
  getStoredCommitMessage,
  commitContext,
  noUiContext,
  executeCommit,
  fakeCommit,
} from '../../../tests/commitTool.js';
import { commentPolicyHash } from './commentReview.js';
import type { reviewComments } from './commentReview.js';
import { createCommitTool as createReviewedCommitTool } from './tool.js';
import type { CommentReview } from './types.js';
import { commitFailedError, validatePaths, validateSubject } from './validation.js';

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

  it('rejects sensitive files in subdirectories', () => {
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

  it('keeps backslash traversal and sensitive path validation', () => {
    for (const path of [
      '..\\private',
      'src\\..\\..\\private',
      '.ssh\\config',
      'config\\.env',
      'folder\\credentials.json',
    ]) {
      expect(() => {
        validatePaths([path]);
      }).toThrow(/Invalid path/);
    }
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

const createPrefetchRepository = async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(repositoryDirectory, 'base.txt', 'base\n');
  await git(repositoryDirectory, ['add', 'base.txt']);
  await git(repositoryDirectory, ['commit', '-m', 'chore: base']);

  const groups = ['one', 'two', 'three'].map((name) => ({
    files: [`${name}.txt`],
    subject: `feat: add ${name}`,
  }));

  for (const group of groups) {
    await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
  }

  return { repositoryDirectory, groups };
};

describe('commitTool.execute', () => {
  it('returns blocking findings on every retry and reports earlier commits', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    const groups = ['one', 'two', 'three'].map((name) => ({
      files: [`${name}.txt`],
      subject: `feat: add ${name}`,
    }));

    for (const group of groups) {
      await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
    }

    const review = vi
      .fn<typeof reviewComments>()
      .mockResolvedValueOnce({ findings: [] })
      .mockResolvedValue({
        findings: [{ path: 'two.txt', line: 1, kind: 'inaccurate', message: 'Remove stale note.' }],
      });
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );
    const { context, custom } = fakeCommit();
    context.cwd = repositoryDirectory;

    await expect(
      tool.execute('batch', { groups }, undefined, undefined, context as never),
    ).rejects.toThrow(/Comment review needs corrections:.*Remove stale note\./s);

    expect(custom).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledTimes(2);

    const retry = () =>
      tool.execute('retry', { groups: groups.slice(1) }, undefined, undefined, context as never);

    await expect(retry()).rejects.toThrow(
      /Comment review needs corrections:.*Remove stale note\./s,
    );

    expect(custom).not.toHaveBeenCalled();
    await expect(retry()).rejects.toThrow(/Comment review refused.*Remove stale note\./s);

    expect(custom).not.toHaveBeenCalled();
    expect((await git(repositoryDirectory, ['log', '--format=%s'])).trim()).toBe(
      groups[0]!.subject,
    );
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('reviews later files changed by an earlier hook', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool(
      {
        exec: async (command, commandArguments, options) => {
          const result = await runCommand(
            command,
            commandArguments,
            options?.cwd ?? repositoryDirectory,
          );

          // Simulate a group-1 hook that edits a later group's file without staging it.
          if (commandArguments[0] === 'commit') {
            await writeRepositoryFile(repositoryDirectory, 'three.txt', 'rewritten by a hook');
          }

          return result;
        },
      },
      review,
    );

    await tool.execute(
      'batch',
      { groups },
      undefined,
      undefined,
      commitContext(repositoryDirectory),
    );

    expect(review).toHaveBeenCalledTimes(3);
    const reviewedTree = review.mock.calls[2]![3].tree;
    expect(await git(repositoryDirectory, ['show', `${reviewedTree}:three.txt`])).toBe(
      'rewritten by a hook',
    );
    expect(await git(repositoryDirectory, ['show', 'HEAD:three.txt'])).toBe('rewritten by a hook');
    expect((await git(repositoryDirectory, ['rev-list', '--count', 'HEAD'])).trim()).toBe('4');
  });

  it('reviews and commits groups serially', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const events: string[] = [];

    const review = vi.fn<typeof reviewComments>(() => {
      events.push('review');

      return Promise.resolve({ findings: [] });
    });

    const custom = vi.fn<() => never>(() => {
      throw new Error('Unexpected commit UI');
    });
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) => {
          if (commandArguments[0] === 'commit') {
            events.push('commit');
          }

          return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
        },
      },
      review,
    );

    await tool.execute('batch', { groups }, undefined, undefined, {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: { custom },
    } as never);

    expect(custom).not.toHaveBeenCalled();
    expect(events).toEqual(['review', 'commit', 'review', 'commit', 'review', 'commit']);
    expect((await git(repositoryDirectory, ['rev-list', '--count', 'HEAD'])).trim()).toBe('4');
  });

  it.each([
    { files: ['two.txt'], subject: 'invalid' },
    { files: ['.env'], subject: 'feat: add two' },
  ])('validates all groups before staging: %j', async (invalid) => {
    const { input, execute, exec } = fakeCommit();
    input.groups.push({ ...invalid, body: '' });

    await expect(execute()).rejects.toThrow(/Invalid/);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'corrections', 'review failure', 'hook'])(
    'stops on %s and names earlier commits',
    async (failure) => {
      const repositoryDirectory = await createTemporaryRepository();

      const groups = ['one', 'two', 'three', 'four'].map((name) => ({
        files: [`${name}.txt`],
        subject: `feat: add ${name}`,
      }));

      for (const group of groups) {
        await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
      }

      const controller = new AbortController();
      let reviews = 0;

      const review = async () => {
        reviews += 1;

        if (reviews === 3 && failure === 'corrections') {
          return {
            findings: [
              { path: 'three.txt', line: 1, kind: 'inaccurate' as const, message: 'Fix comment.' },
            ],
          };
        }

        if (reviews === 3 && failure === 'review failure') {
          throw new Error('Reviewer unavailable');
        }

        if (reviews === 3 && failure === 'cancel') {
          controller.abort();
        }

        if (reviews === 3 && failure === 'hook') {
          await writeRepositoryFile(
            repositoryDirectory,
            '.git/hooks/pre-commit',
            '#!/bin/sh\necho hook said no >&2\nexit 1\n',
          );
          await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);
        }

        return { findings: [] };
      };
      const tool = createReviewedCommitTool(
        {
          exec: (command, commandArguments, options) =>
            runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
        },
        review,
      );
      const failureError = await tool
        .execute(
          'batch',
          { groups },
          controller.signal,
          undefined,
          commitContext(repositoryDirectory),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const commitHashes = (await git(repositoryDirectory, ['log', '--reverse', '--format=%H']))
        .trim()
        .split('\n');

      expect(failureError).toBeInstanceOf(Error);
      expect(commitHashes).toHaveLength(2);

      for (const [index, commitHash] of commitHashes.entries()) {
        expect((failureError as Error).message).toContain(`Group ${index + 1}/4: ${commitHash}`);
      }

      expect((failureError as Error).message).toContain('Group 3/4');
      expect((failureError as Error).message).toContain(
        {
          cancel: 'cancelled',
          corrections: 'Comment review needs corrections',
          'review failure': 'Reviewer unavailable',
          hook: 'hook said no',
        }[failure]!,
      );

      expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('2');
      expect(reviews).toBe(3);
      expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

      if (failure === 'hook') {
        await rm(join(repositoryDirectory, '.git/hooks/pre-commit'));
      }

      const result = await tool.execute(
        'retry',
        { groups: groups.slice(3) },
        undefined,
        undefined,
        commitContext(repositoryDirectory),
      );

      expect(result.details.groups[0]!.sha).not.toBe('');
      expect(
        (await git(repositoryDirectory, ['show', '--name-only', '--format=', 'HEAD'])).trim(),
      ).toBe('four.txt');

      expect(await git(repositoryDirectory, ['status', '--short'])).toBe('?? three.txt\n');
    },
  );

  it('commits and names hook changes against the reviewed tree', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'retry.ts', 'export const retries = 0;\n');

    const hookPath = join(repositoryDirectory, '.git/hooks/pre-commit');

    await writeFile(
      hookPath,
      '#!/bin/sh\nprintf "// Unreviewed comment\\n" >> retry.ts\ngit add retry.ts\n',
    );
    await chmod(hookPath, 0o755);

    const result = await executeCommit(repositoryDirectory, {
      groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }],
    });

    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('1');
    expect(await git(repositoryDirectory, ['show', 'HEAD:retry.ts'])).toContain(
      '// Unreviewed comment',
    );
    expect(result.details.groups[0]).toMatchObject({
      files: ['retry.ts'],
      hookChanges: { files: ['retry.ts'], message: false },
    });
    expect(JSON.stringify(result.content)).toContain('Hook changed paths: retry.ts');
    const reviewedTree = result.details.groups[0]!.commentReview!.tree;
    expect(await git(repositoryDirectory, ['show', `${reviewedTree}:retry.ts`])).not.toContain(
      '// Unreviewed comment',
    );
  });

  it.each(['unverified', 'policy'] as const)(
    'commits and reports a %s finding as advisory',
    async (kind) => {
      const repositoryDirectory = await createTemporaryRepository();

      await writeRepositoryFile(
        repositoryDirectory,
        'note.ts',
        '// Narration.\nexport const value = 1;\n',
      );

      const review = vi.fn<typeof reviewComments>().mockResolvedValue({
        findings: [
          {
            path: 'note.ts',
            line: 1,
            kind,
            message: 'Narration.',
          },
        ],
      });
      const tool = createReviewedCommitTool(
        {
          exec: (command, commandArguments, options) =>
            runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
        },
        review,
      );

      const result = await tool.execute(
        'batch',
        { groups: [{ files: ['note.ts'], subject: 'feat: add note' }] },
        undefined,
        undefined,
        commitContext(repositoryDirectory),
      );

      expect((await git(repositoryDirectory, ['log', '-1', '--format=%s'])).trim()).toBe(
        'feat: add note',
      );
      expect(JSON.stringify(result.content)).toContain('[advisory] Narration.');
    },
  );

  it('rejects staged content changed during comment review', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'retry.ts', 'export const retries = 0;\n');

    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      async () => {
        await writeRepositoryFile(
          repositoryDirectory,
          'retry.ts',
          '// Unreviewed comment\nexport const retries = 1;\n',
        );
        await git(repositoryDirectory, ['add', 'retry.ts']);

        return { findings: [] };
      },
    );

    await expect(
      tool.execute(
        'changed',
        { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        commitContext(repositoryDirectory),
      ),
    ).rejects.toThrow(/changed since comment review/);
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });

  it('expires old abandoned review groups', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    const review = vi.fn<() => Promise<CommentReview>>(async () => ({
      findings: [
        { path: 'retry.ts', line: 1, kind: 'inaccurate' as const, message: 'Stale comment.' },
      ],
    }));
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );

    const call = (path: string) =>
      tool.execute(
        'test',
        { groups: [{ files: [path], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        commitContext(repositoryDirectory),
      );

    for (let index = 0; index < 33; index += 1) {
      const path = `retry${index}.ts`;

      await writeRepositoryFile(repositoryDirectory, path, '// stale\n');

      await expect(call(path)).rejects.toThrow('Comment review needs corrections');
    }

    await expect(call('retry0.ts')).rejects.toThrow('Comment review needs corrections');
    expect(review).toHaveBeenCalledTimes(34);
  }, 30_000);

  it('creates one commit and returns the HEAD hash in details', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    const result = await executeCommit(repositoryDirectory, {
      groups: [
        {
          files: ['README.md'],
          subject: 'feat: add thing',
          body: 'Initial project file.',
        },
      ],
    });

    const commitHashOutput = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
    const logOutput = await git(repositoryDirectory, ['log', '--oneline']);
    const latestSubjectOutput = await git(repositoryDirectory, ['log', '-1', '--format=%s']);

    const commitHash = commitHashOutput.trim();
    const logLines = logOutput.trim().split('\n');
    const latestSubject = latestSubjectOutput.trim();

    expect(logLines).toHaveLength(1);
    expect(latestSubject).toBe('feat: add thing');
    expect(result.details.groups[0]).toEqual({
      sha: commitHash,
      files: ['README.md'],
      subject: 'feat: add thing',
      body: 'Initial project file.\n',
      message: 'feat: add thing\n\nInitial project file.\n',
      hooks: 'run',
      hookChanges: { files: [], message: false },
      commentReview: {
        status: 'passed',
        tree: (await git(repositoryDirectory, ['rev-parse', 'HEAD^{tree}'])).trim(),
        policy: commentPolicyHash,
        report: '',
      },
    });

    expect(result.content).toEqual([
      {
        type: 'text',
        text: `${commitHash} feat: add thing\nGit hooks: run.`,
      },
    ]);
  });

  it('includes the body in the committed message when body is provided', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    await executeCommit(repositoryDirectory, {
      groups: [
        {
          files: ['README.md'],
          subject: 'feat: add',
          body: 'Longer explanation here.',
        },
      ],
    });

    const body = await getStoredCommitMessage(repositoryDirectory);

    expect(body).toBe('feat: add\n\nLonger explanation here.\n');
  });

  it('refuses to commit when unrelated paths are already staged', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'notes.md', 'keep staged\n');
    await git(repositoryDirectory, ['add', '--', 'notes.md']);

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: notes\.md/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('refuses to commit a glob, because git matches the pattern literally', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'src/a.ts', 'export const a = 1;\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['*'],
            subject: 'feat: add everything',
          },
        ],
      }),
    ).rejects.toThrow(/git --literal-pathspecs add -- \* failed/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('commits when the working directory is a subdirectory of the repository', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'sub/a.txt', 'hello\n');
    await writeRepositoryFile(
      repositoryDirectory,
      'sub/tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'exit 81'],
        check: ['sh', '-c', 'exit 82'],
      }),
    );
    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'printf "prepared\\n" > sub/a.txt'],
        check: ['grep', '-qx', 'prepared', 'sub/a.txt'],
      }),
    );
    await git(repositoryDirectory, ['add', 'tau.json', 'sub/tau.json']);
    await git(repositoryDirectory, ['commit', '-m', 'chore: configure commands']);

    const commitTool = createCommitTool({
      exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
        return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
      },
    });

    const result = await commitTool.execute(
      'tool-call-1',
      { groups: [{ files: ['a.txt'], subject: 'feat: add a' }] },
      undefined,
      undefined,
      commitContext(join(repositoryDirectory, 'sub')),
    );

    expect(result.details.groups[0]?.files).toEqual(['sub/a.txt']);
    expect(await git(repositoryDirectory, ['show', 'HEAD:sub/a.txt'])).toBe('hello\n');
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('2');
    expect(
      (await git(repositoryDirectory, ['show', '--name-only', '--format=', 'HEAD'])).trim(),
    ).toBe('sub/a.txt');
  });

  it('rejects mixed file and directory requests before staging', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'src/a.ts', 'export const a = 1;\n');
    await writeRepositoryFile(repositoryDirectory, 'src/b.ts', 'export const b = 2;\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['src/a.ts', 'src'],
            subject: 'feat: add sources',
          },
        ],
      }),
    ).rejects.toThrow(/Directory requests are not supported/i);

    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('rejects directory requests before staging their contents', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'src/a.ts', 'export const a = 1;\n');
    await writeRepositoryFile(repositoryDirectory, 'src/b.ts', 'export const b = 2;\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['src'],
            subject: 'feat: add sources',
          },
        ],
      }),
    ).rejects.toThrow(/Directory requests are not supported/i);

    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('refuses to commit when an unrelated staged type change exists', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'link.txt', 'plain\n');
    await git(repositoryDirectory, ['add', '--', 'README.md', 'link.txt']);
    await git(repositoryDirectory, ['commit', '-m', 'initial']);

    await rm(join(repositoryDirectory, 'link.txt'));
    await symlink('/etc/hostname', join(repositoryDirectory, 'link.txt'));
    await git(repositoryDirectory, ['add', '--', 'link.txt']);

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'updated\n');

    await expect(
      executeCommit(repositoryDirectory, {
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
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'old.md', 'gone\n');
    await git(repositoryDirectory, ['add', '--', 'README.md', 'old.md']);
    await git(repositoryDirectory, ['commit', '-m', 'initial']);
    await git(repositoryDirectory, ['rm', '--', 'old.md']);

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'updated\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: update readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: old\.md/i);
  });

  it('keeps an initial commit when a hook stages additional paths', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'sneaky.txt', 'not requested\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\ngit add -- sneaky.txt\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    const result = await executeCommit(repositoryDirectory, {
      groups: [{ files: ['README.md'], subject: 'feat: add readme' }],
    });

    expect(result.details.groups[0]).toMatchObject({
      files: ['README.md', 'sneaky.txt'],
      hookChanges: { files: ['sneaky.txt'], message: false },
    });
    expect(await git(repositoryDirectory, ['show', 'HEAD:sneaky.txt'])).toBe('not requested\n');

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('1');
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('keeps existing history when a hook stages an additional path', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'base.txt', 'base\n');
    await git(repositoryDirectory, ['add', '--', 'base.txt']);
    await git(repositoryDirectory, ['commit', '-m', 'chore: base']);

    const baseCommitHash = (await git(repositoryDirectory, ['rev-parse', 'HEAD'])).trim();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'sneaky.txt', 'not requested\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\ngit add -- sneaky.txt\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    const result = await executeCommit(repositoryDirectory, {
      groups: [{ files: ['README.md'], subject: 'feat: add readme' }],
    });

    expect((await git(repositoryDirectory, ['rev-parse', 'HEAD^'])).trim()).toBe(baseCommitHash);
    expect(result.details.groups[0]!.sha).toBe(
      (await git(repositoryDirectory, ['rev-parse', 'HEAD'])).trim(),
    );
    expect(await git(repositoryDirectory, ['show', 'HEAD:sneaky.txt'])).toBe('not requested\n');
  });

  it('reports hook failure details and leaves no commits when git commit fails', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\necho hook output\necho hook said no >&2\nexit 1\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    let thrown: unknown;

    try {
      await executeCommit(repositoryDirectory, {
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

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  }, 10_000);

  it('preserves raw hook output including whitespace in both streams', () => {
    expect(commitFailedError('hook output  \n', '   \n').message).toBe(
      'git commit failed:\nhook output  \n   \n',
    );
  });

  it('keeps both streams in the error message when a hook writes to each', () => {
    const message = commitFailedError('lint failed on src/a.ts\n', 'warning: slow hook\n').message;

    expect(message).toContain('lint failed on src/a.ts');
    expect(message).toContain('warning: slow hook');
  });
});

describe('commits without approvals', () => {
  it('invalidates cached review when the shared delegate changes', async ({ onTestFinished }) => {
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const { exec, context, input } = fakeCommit();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({
      findings: [{ path: 'README.md', line: 1, kind: 'inaccurate', message: 'Incorrect claim.' }],
    });
    const tool = createReviewedCommitTool({ exec }, review);

    vi.stubEnv('TAU_DELEGATE_MODEL', 'first/model');
    await expect(
      tool.execute('first', input, undefined, undefined, context as never),
    ).rejects.toThrow('needs corrections');
    vi.stubEnv('TAU_DELEGATE_MODEL', 'second/model');
    await expect(
      tool.execute('second', input, undefined, undefined, context as never),
    ).rejects.toThrow('needs corrections');

    expect(review).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });

  it('reviews and commits every group without opening the overlay', async () => {
    const { exec, context, custom } = fakeCommit();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool({ exec }, review);
    const groups = [
      { files: ['one.txt'], subject: 'feat: add one' },
      { files: ['two.txt'], subject: 'feat: add two' },
    ];

    const result = await tool.execute('batch', { groups }, undefined, undefined, context as never);

    expect(result.details.groups.map((group) => group.subject)).toEqual(
      groups.map((group) => group.subject),
    );
    expect(review).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.filter((call) => call[1][0] === 'commit')).toHaveLength(2);
    expect(custom).not.toHaveBeenCalled();
  });

  it('returns review failures and never opens a waiver dialog', async () => {
    const { exec, context, custom, input } = fakeCommit();
    const review = vi
      .fn<typeof reviewComments>()
      .mockRejectedValue(new Error('Reviewer unavailable'));
    const tool = createReviewedCommitTool({ exec }, review);

    await expect(
      tool.execute('call', input, undefined, undefined, context as never),
    ).rejects.toThrow(
      /^Comment review failed: Reviewer unavailable\nFix the cause and call commit again\.$/,
    );

    expect(custom).not.toHaveBeenCalled();
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });

  it('returns a blocker after two correction attempts without waiving findings', async () => {
    const { exec, context, custom, input } = fakeCommit();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({
      findings: [{ path: 'README.md', line: 1, kind: 'inaccurate', message: 'Incorrect claim.' }],
    });
    const tool = createReviewedCommitTool({ exec }, review);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const groups = [
        {
          ...input.groups[0]!,
          body: `Attempt ${attempt}`,
          commentDispute: `Evidence ${attempt}`,
        },
      ];

      await expect(
        tool.execute('call', { groups }, undefined, undefined, context as never),
      ).rejects.toThrow(
        attempt <= 2 ? 'Comment review needs corrections' : 'Comment review refused',
      );
    }

    expect(review.mock.calls.map((call) => call[3].dispute)).toEqual([
      'Evidence 1',
      'Evidence 2',
      'Evidence 3',
    ]);
    expect(custom).not.toHaveBeenCalled();
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });

  it('keeps the return limit after review failure and accepts a corrected tree', async () => {
    const repositoryDirectory = await createTemporaryRepository();
    await writeRepositoryFile(repositoryDirectory, 'retry.ts', '// stale\n');
    const findings = {
      findings: [
        { path: 'retry.ts', line: 1, kind: 'inaccurate' as const, message: 'Stale note.' },
      ],
    };
    const review = vi
      .fn<typeof reviewComments>()
      .mockResolvedValueOnce(findings)
      .mockRejectedValueOnce(new Error('Reviewer unavailable'))
      .mockResolvedValueOnce(findings)
      .mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool(
      {
        exec: (command, argumentsList, options) =>
          runCommand(command, argumentsList, options?.cwd ?? repositoryDirectory),
      },
      review,
    );
    const call = (commentDispute?: string) =>
      tool.execute(
        'retry',
        {
          groups: [
            {
              files: ['retry.ts'],
              subject: 'feat: retry',
              ...(commentDispute ? { commentDispute } : {}),
            },
          ],
        },
        undefined,
        undefined,
        commitContext(repositoryDirectory),
      );

    await expect(call()).rejects.toThrow('Comment review needs corrections');
    await expect(call()).rejects.toThrow('Comment review needs corrections');
    await expect(call('Constraint evidence')).rejects.toThrow('Reviewer unavailable');
    await expect(call('Constraint evidence')).rejects.toThrow('Comment review refused');
    await expect(call('Different evidence after refusal')).rejects.toThrow(
      'Comment review refused',
    );
    expect(review).toHaveBeenCalledTimes(3);
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

    await writeRepositoryFile(repositoryDirectory, 'retry.ts', 'export const retries = 0;\n');
    const result = await call();

    expect(result.details.groups[0]!.sha).toBe(
      (await git(repositoryDirectory, ['rev-parse', 'HEAD'])).trim(),
    );
    expect(review).toHaveBeenCalledTimes(4);
    expect(await git(repositoryDirectory, ['show', 'HEAD:retry.ts'])).toBe(
      'export const retries = 0;\n',
    );
  });

  it('ignores obsolete project checks without a UI', async () => {
    const repositoryDirectory = await createTemporaryRepository();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );

    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({ check: ['node', '-e', 'process.exit(1)'] }),
    );

    await expect(
      tool.execute(
        'call',
        {
          groups: [{ files: ['tau.json'], subject: 'feat: add package' }],
        },
        undefined,
        undefined,
        noUiContext(repositoryDirectory),
      ),
    ).resolves.toHaveProperty('details.groups.0.sha');

    expect(review).toHaveBeenCalledOnce();
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('1');
  });
});

describe('commit execution', () => {
  it('applies a dispute only to the group carrying it', async () => {
    const { exec, context } = fakeCommit();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool({ exec }, review);
    const groups = [
      { files: ['one.txt'], subject: 'feat: add one', commentDispute: 'Explains a constraint.' },
      { files: ['two.txt'], subject: 'feat: add two' },
    ];
    const result = await tool.execute('batch', { groups }, undefined, undefined, context as never);

    expect(review.mock.calls.map((call) => call[3].dispute)).toEqual([
      'Explains a constraint.',
      undefined,
    ]);

    expect(result.details.groups[0]!.commentReview!.report).toContain('rechecked after dispute');
    expect(result.details.groups[1]!.commentReview!.report).not.toContain(
      'rechecked after dispute',
    );

    expect(result.details.groups[1]!.commentReview!.report).not.toContain(
      'No prior findings available.',
    );
  });

  it('returns without UI or git operations when already cancelled', async () => {
    const { execute, exec, custom } = fakeCommit();

    await execute(AbortSignal.abort());

    expect(exec).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });

  it('unstages the requested files when the index cannot be read before a snapshot', async () => {
    const { execute, exec } = fakeCommit();
    const readGit = exec.getMockImplementation();

    if (readGit === undefined) {
      throw new Error('fakeCommit has no Git implementation');
    }

    exec.mockImplementation((command, commandArguments, options) =>
      commandArguments[0] === 'ls-files'
        ? Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'index locked' })
        : readGit(command, commandArguments, options),
    );

    await expect(execute()).rejects.toThrow('index locked');

    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });

  it('unstages without opening UI if cancelled while staging', async () => {
    const controller = new AbortController();
    const { execute, exec, custom, gitDirectory } = fakeCommit();
    exec.mockImplementation((_command, commandArguments) => {
      if (commandArguments.includes('add')) {
        controller.abort();
      }

      let stdout = '';

      if (commandArguments.includes('--absolute-git-dir')) {
        stdout = `${gitDirectory}\n`;
      } else if (commandArguments.includes('--show-toplevel')) {
        stdout = '/repo\n';
      } else if (commandArguments.includes('--show-prefix')) {
        stdout = 'true\n\n';
      }

      return Promise.resolve({ code: 0, killed: false, stdout, stderr: '' });
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
