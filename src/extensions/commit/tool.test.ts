import { execFile } from 'node:child_process';
import { chmod, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { runGit } from '../../git.js';
import {
  runCommand,
  createTemporaryRepository,
  writeRepositoryFile,
  getStoredCommitMessage,
  commitContext,
  executeCommit,
  fakeCommit,
  readGitBlob,
} from './fixtures/commitTool.js';
import { createCommitTool } from './tool.js';
import { commitFailedError, validatePaths, validateSubject } from './validation.js';

describe('validateSubject', () => {
  it('throws a validation error naming the subject when it is not a conventional commit', () => {
    const subject = 'Add stuff.';

    expect(() => {
      validateSubject(subject);
    }).toThrow(new RegExp(`subject.*${subject.replace('.', '\\.')}`, 'i'));
  });

  it('names the allowed types when it rejects a subject', () => {
    for (const type of ['fix', 'refactor', 'revert']) {
      expect(() => {
        validateSubject('feat(prFeedback): x');
      }).toThrow(new RegExp(`\\b${type}\\b`));
    }
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

  it('names the sensitive pattern that matched the path', () => {
    expect(() => {
      validatePaths(['docs/secrets_management.md']);
    }).toThrow('/secret/i');
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
  await git(repositoryDirectory, 'add', 'base.txt');
  await git(repositoryDirectory, 'commit', '-m', 'chore: base');

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
  it('commits later files changed by an earlier hook', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();

    const tool = createCommitTool(async (cwd, commandArguments, options) => {
      const result = await runGit(cwd, commandArguments, options);

      if (commandArguments[0] === 'commit') {
        await writeRepositoryFile(repositoryDirectory, 'three.txt', 'rewritten by a hook');
      }

      return result;
    });

    await tool.execute(
      'batch',
      { groups },
      undefined,
      undefined,
      commitContext(repositoryDirectory),
    );

    expect(await readGitBlob(repositoryDirectory, 'HEAD:three.txt')).toBe('rewritten by a hook');
    expect((await git(repositoryDirectory, 'rev-list', '--count', 'HEAD')).trim()).toBe('4');
  });

  it.each([
    { files: ['two.txt'], subject: 'invalid' },
    { files: ['.env'], subject: 'feat: add two' },
  ])('validates all groups before staging: %j', async (invalid) => {
    const { input, execute, runner } = fakeCommit();
    input.groups.push({ ...invalid, body: '' });

    await expect(execute()).rejects.toThrow(/Invalid/);
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'hook'])('stops on %s and names earlier commits', async (failure) => {
    const repositoryDirectory = await createTemporaryRepository();

    const groups = ['one', 'two', 'three', 'four'].map((name) => ({
      files: [`${name}.txt`],
      subject: `feat: add ${name}`,
    }));

    for (const group of groups) {
      await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
    }

    const controller = new AbortController();
    let stagings = 0;

    const tool = createCommitTool(async (cwd, commandArguments, options) => {
      if (commandArguments.includes('add')) {
        stagings += 1;
      }

      if (stagings === 3 && commandArguments.includes('add') && failure === 'cancel') {
        controller.abort();
      }

      if (stagings === 3 && commandArguments.includes('add') && failure === 'hook') {
        await writeRepositoryFile(
          repositoryDirectory,
          '.git/hooks/pre-commit',
          '#!/bin/sh\necho hook said no >&2\nexit 1\n',
        );

        await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);
      }

      return runGit(cwd, commandArguments, options);
    });

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

    const commitHashes = (await git(repositoryDirectory, 'log', '--reverse', '--format=%H'))
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
        hook: 'hook said no',
      }[failure]!,
    );

    expect((await git(repositoryDirectory, 'rev-list', '--all', '--count')).trim()).toBe('2');
    expect(stagings).toBe(3);
    expect(await git(repositoryDirectory, 'diff', '--cached', '--name-only')).toBe('');

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
      (await git(repositoryDirectory, 'show', '--name-only', '--format=', 'HEAD')).trim(),
    ).toBe('four.txt');

    expect(
      (await promisify(execFile)('git', ['status', '--short'], { cwd: repositoryDirectory }))
        .stdout,
    ).toBe('?? three.txt\n');
  });

  it('commits and names hook changes against the staged tree', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'retry.ts', 'export const retries = 0;\n');

    const hookPath = join(repositoryDirectory, '.git/hooks/pre-commit');

    await writeFile(
      hookPath,
      '#!/bin/sh\nprintf "// Hook comment\\n" >> retry.ts\ngit add retry.ts\n',
    );

    await chmod(hookPath, 0o755);

    const result = await executeCommit(repositoryDirectory, {
      groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }],
    });

    expect((await git(repositoryDirectory, 'rev-list', '--all', '--count')).trim()).toBe('1');
    expect(await git(repositoryDirectory, 'show', 'HEAD:retry.ts')).toContain('// Hook comment');

    expect(result.details.groups[0]).toMatchObject({
      files: ['retry.ts'],
      hookChanges: { files: ['retry.ts'], message: false },
    });

    expect(JSON.stringify(result.content)).toContain('Hook changed paths: retry.ts');
  });

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

    const commitHashOutput = await git(repositoryDirectory, 'rev-parse', 'HEAD');
    const logOutput = await git(repositoryDirectory, 'log', '--oneline');
    const latestSubjectOutput = await git(repositoryDirectory, 'log', '-1', '--format=%s');

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
    await git(repositoryDirectory, 'add', '--', 'notes.md');

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
    ).rejects.toThrow(/Unknown paths: \*/i);

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

    await writeRepositoryFile(repositoryDirectory, 'baseline', 'baseline\n');
    await git(repositoryDirectory, 'add', 'baseline');
    await git(repositoryDirectory, 'commit', '-m', 'test: baseline');

    const commitTool = createCommitTool(runGit);

    const result = await commitTool.execute(
      'tool-call-1',
      { groups: [{ files: ['a.txt'], subject: 'feat: add a' }] },
      undefined,
      undefined,
      commitContext(join(repositoryDirectory, 'sub')),
    );

    expect(result.details.groups[0]?.files).toEqual(['sub/a.txt']);

    expect(
      (await promisify(execFile)('git', ['show', 'HEAD:sub/a.txt'], { cwd: repositoryDirectory }))
        .stdout,
    ).toBe('hello\n');

    expect((await git(repositoryDirectory, 'rev-list', '--all', '--count')).trim()).toBe('2');

    expect(
      (await git(repositoryDirectory, 'show', '--name-only', '--format=', 'HEAD')).trim(),
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

    expect(await git(repositoryDirectory, 'diff', '--cached', '--name-only')).toBe('');
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

    expect(await git(repositoryDirectory, 'diff', '--cached', '--name-only')).toBe('');

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
    await git(repositoryDirectory, 'add', '--', 'README.md', 'link.txt');
    await git(repositoryDirectory, 'commit', '-m', 'initial');

    await rm(join(repositoryDirectory, 'link.txt'));
    await symlink('/etc/hostname', join(repositoryDirectory, 'link.txt'));
    await git(repositoryDirectory, 'add', '--', 'link.txt');

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
    await git(repositoryDirectory, 'add', '--', 'README.md', 'old.md');
    await git(repositoryDirectory, 'commit', '-m', 'initial');
    await git(repositoryDirectory, 'rm', '--', 'old.md');

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

  it('commits an already-staged deletion in one commit with the other requested files', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'old.md', 'gone\n');
    await git(repositoryDirectory, 'add', '--', 'README.md', 'old.md');
    await git(repositoryDirectory, 'commit', '-m', 'initial');
    await git(repositoryDirectory, 'rm', '--', 'old.md');
    await writeRepositoryFile(repositoryDirectory, 'README.md', 'updated\n');
    await writeRepositoryFile(repositoryDirectory, 'new.md', 'new\n');

    await executeCommit(repositoryDirectory, {
      groups: [{ files: ['README.md', 'old.md', 'new.md'], subject: 'feat: replace old notes' }],
    });

    expect(
      (
        await promisify(execFile)('git', ['show', '--name-status', '--format=', 'HEAD'], {
          cwd: repositoryDirectory,
        })
      ).stdout,
    ).toBe('M\tREADME.md\nA\tnew.md\nD\told.md\n');

    expect(
      (
        await promisify(execFile)('git', ['rev-list', '--count', 'HEAD'], {
          cwd: repositoryDirectory,
        })
      ).stdout,
    ).toBe('2\n');

    expect(await git(repositoryDirectory, 'status', '--short')).toBe('');
  });

  it('commits a recreated file over its staged deletion', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'old.md', 'gone\n');
    await git(repositoryDirectory, 'add', '--', 'old.md');
    await git(repositoryDirectory, 'commit', '-m', 'initial');
    await git(repositoryDirectory, 'rm', '--', 'old.md');
    await writeRepositoryFile(repositoryDirectory, 'old.md', 'recreated\n');

    await executeCommit(repositoryDirectory, {
      groups: [{ files: ['old.md'], subject: 'feat: rewrite old notes' }],
    });

    expect(
      (await promisify(execFile)('git', ['show', 'HEAD:old.md'], { cwd: repositoryDirectory }))
        .stdout,
    ).toBe('recreated\n');

    expect(await git(repositoryDirectory, 'status', '--short')).toBe('');
  });

  it.each([
    {
      failure: 'path validation',
      files: ['README.md', 'old.md', 'new.md', 'missing.md'],
      hook: '',
      error: 'Unknown paths: missing.md',
    },
    {
      failure: 'hook',
      files: ['README.md', 'old.md', 'new.md'],
      hook: 'exit 1',
      error: 'git commit failed',
    },
    {
      failure: 'a hook that restages a deleted path',
      files: ['README.md', 'old.md', 'new.md'],
      hook: 'echo back > old.md; git add old.md; exit 1',
      error: 'git commit failed',
    },
  ])('keeps changes staged before the call when $failure fails', async ({ files, hook, error }) => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'old.md', 'gone\n');
    await git(repositoryDirectory, 'add', '--', 'README.md', 'old.md');
    await git(repositoryDirectory, 'commit', '-m', 'initial');
    await git(repositoryDirectory, 'rm', '--', 'old.md');
    await writeRepositoryFile(repositoryDirectory, 'README.md', 'staged\n');
    await git(repositoryDirectory, 'add', '--', 'README.md');
    await writeRepositoryFile(repositoryDirectory, 'README.md', 'unstaged\n');
    await writeRepositoryFile(repositoryDirectory, 'new.md', 'new\n');

    if (hook) {
      await writeRepositoryFile(
        repositoryDirectory,
        '.git/hooks/pre-commit',
        `#!/bin/sh\n${hook}\n`,
      );

      await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);
    }

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [{ files, subject: 'feat: replace old notes' }],
      }),
    ).rejects.toThrow(error);

    expect(
      (
        await promisify(execFile)('git', ['diff', '--cached', '--name-status'], {
          cwd: repositoryDirectory,
        })
      ).stdout,
    ).toBe('M\tREADME.md\nD\told.md\n');

    expect(
      (await promisify(execFile)('git', ['show', ':README.md'], { cwd: repositoryDirectory }))
        .stdout,
    ).toBe('staged\n');

    expect(
      (
        await promisify(execFile)('git', ['rev-list', '--count', 'HEAD'], {
          cwd: repositoryDirectory,
        })
      ).stdout,
    ).toBe('1\n');
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

    expect(
      (await promisify(execFile)('git', ['show', 'HEAD:sneaky.txt'], { cwd: repositoryDirectory }))
        .stdout,
    ).toBe('not requested\n');

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('1');
    expect(await git(repositoryDirectory, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('keeps existing history when a hook stages an additional path', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'base.txt', 'base\n');
    await git(repositoryDirectory, 'add', '--', 'base.txt');
    await git(repositoryDirectory, 'commit', '-m', 'chore: base');

    const baseCommitHash = (await git(repositoryDirectory, 'rev-parse', 'HEAD')).trim();

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

    expect((await git(repositoryDirectory, 'rev-parse', 'HEAD^')).trim()).toBe(baseCommitHash);

    expect(result.details.groups[0]!.sha).toBe(
      (await git(repositoryDirectory, 'rev-parse', 'HEAD')).trim(),
    );

    expect(
      (await promisify(execFile)('git', ['show', 'HEAD:sneaky.txt'], { cwd: repositoryDirectory }))
        .stdout,
    ).toBe('not requested\n');
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

  it('drops ANSI escapes and lint-staged progress lines but keeps the real error', () => {
    const stdout = [
      '\u001B[33m[STARTED]\u001B[39m Preparing lint-staged...',
      '[COMPLETED] Preparing lint-staged...',
      '[SKIPPED] *.md — no files',
      '\u001B[31m[FAILED]\u001B[39m eslint --fix [FAILED]',
      '',
    ].join('\n');

    const stderr = '\u001B[1msrc/a.ts:3:1 error no-unused-vars\u001B[22m\n';

    expect(commitFailedError(stdout, stderr).message).toBe(
      'git commit failed:\n[FAILED] eslint --fix [FAILED]\nsrc/a.ts:3:1 error no-unused-vars\n',
    );
  });
});

describe('commits without approvals', () => {
  it('commits every group without opening the overlay', async () => {
    const { runner, context, custom } = fakeCommit();
    const tool = createCommitTool(runner);

    const groups = [
      { files: ['one.txt'], subject: 'feat: add one' },
      { files: ['two.txt'], subject: 'feat: add two' },
    ];

    const result = await tool.execute('batch', { groups }, undefined, undefined, context as never);

    expect(result.details.groups.map((group) => group.subject)).toEqual(
      groups.map((group) => group.subject),
    );

    expect(runner.mock.calls.filter((call) => call[1][0] === 'commit')).toHaveLength(2);
    expect(custom).not.toHaveBeenCalled();
  });

  it('commits without a UI', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    const tool = createCommitTool((cwd, commandArguments, options) =>
      runGit(cwd, commandArguments, options),
    );

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    await expect(
      tool.execute(
        'call',
        {
          groups: [{ files: ['README.md'], subject: 'feat: add readme' }],
        },
        undefined,
        undefined,
        noUiContext(repositoryDirectory),
      ),
    ).resolves.toHaveProperty('details.groups.0.sha');

    expect(await git(repositoryDirectory, 'diff', '--cached', '--name-only')).toBe('');
    expect((await git(repositoryDirectory, 'rev-list', '--all', '--count')).trim()).toBe('1');
  });
});

describe('commit execution', () => {
  it('returns without UI or git operations when already cancelled', async () => {
    const { execute, runner, custom } = fakeCommit();

    await execute(AbortSignal.abort());

    expect(runner).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });

  it('unstages the requested files when the index cannot be read before a snapshot', async () => {
    const { execute, runner } = fakeCommit();
    const readGit = runner.getMockImplementation();

    if (readGit === undefined) {
      throw new Error('fakeCommit has no Git implementation');
    }

    runner.mockImplementation((cwd, commandArguments, options) =>
      commandArguments[0] === 'ls-files'
        ? Promise.resolve({ exitCode: 1, stdout: Buffer.alloc(0), stderr: 'index locked' })
        : readGit(cwd, commandArguments, options),
    );

    await expect(execute()).rejects.toThrow('index locked');

    expect(runner).toHaveBeenLastCalledWith(
      '/repo',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { timeoutMilliseconds: null },
    );
  });

  it('unstages without opening UI if cancelled while staging', async () => {
    const controller = new AbortController();
    const { execute, runner, custom } = fakeCommit();
    const readGit = runner.getMockImplementation();

    if (readGit === undefined) {
      throw new Error('fakeCommit has no Git implementation');
    }

    runner.mockImplementation((cwd, commandArguments, options) => {
      if (commandArguments.includes('add')) {
        controller.abort();
      }

      return readGit(cwd, commandArguments, options);
    });

    await execute(controller.signal);

    expect(custom).not.toHaveBeenCalled();

    expect(runner).toHaveBeenLastCalledWith(
      '/repo',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { timeoutMilliseconds: null },
    );
  });
});
