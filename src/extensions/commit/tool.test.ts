import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { CommitInput } from './tool.js';
import { createCommitTool, validatePaths, validateSubject } from './tool.js';

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
    ui: { confirm: () => Promise.resolve(true) },
  }) as never;

const declinedContext = (repoDir: string) =>
  ({
    cwd: repoDir,
    hasUI: true,
    ui: { confirm: () => Promise.resolve(false) },
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

  it('rejects pathspec syntax and traversal attempts', () => {
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

  it('returns without throwing when all files are outside the sensitive denylist', () => {
    expect(() => {
      validatePaths(['src/foo.ts', 'README.md', 'docs/env.md']);
    }).not.toThrow();
  });
});

describe('commitTool.execute', () => {
  it('throws when the user declines the confirmation dialog', async () => {
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
        { files: ['README.md'], subject: 'feat: add thing' },
        undefined,
        undefined,
        declinedContext(repoDir),
      ),
    ).rejects.toThrow(/declined/i);

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
        { files: ['README.md'], subject: 'feat: add thing' },
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
      files: ['README.md'],
      subject: 'feat: add thing',
      body: 'Initial project file.',
    });

    const shaOutput = await git(repoDir, ['rev-parse', 'HEAD']);
    const logOutput = await git(repoDir, ['log', '--oneline']);
    const latestSubjectOutput = await git(repoDir, ['log', '-1', '--format=%s']);

    const sha = shaOutput.trim();
    const logLines = logOutput.trim().split('\n');
    const latestSubject = latestSubjectOutput.trim();

    expect(logLines).toHaveLength(1);
    expect(latestSubject).toBe('feat: add thing');
    expect(result.details).toEqual({
      sha,
      files: ['README.md'],
      subject: 'feat: add thing',
    });
    expect(result.content).toEqual([{ type: 'text', text: `${sha} feat: add thing` }]);
  });

  it('includes the body in the committed message when body is provided', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');

    await executeCommit(repoDir, {
      files: ['README.md'],
      subject: 'feat: add',
      body: 'Longer explanation here.',
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
        files: ['README.md'],
        subject: 'feat: add readme',
      }),
    ).rejects.toThrow(/already staged: notes\.md/i);

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
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
        files: ['README.md'],
        subject: 'feat: update readme',
      }),
    ).rejects.toThrow(/already staged: old\.md/i);
  });

  it('leaves the repo clean when hooks rewrite committed files', async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');
    await writeRepoFile(
      repoDir,
      '.git/hooks/pre-commit',
      '#!/bin/sh\nprintf "formatted\\n" > README.md\ngit add -- README.md\n',
    );
    await chmod(join(repoDir, '.git/hooks/pre-commit'), 0o755);

    await executeCommit(repoDir, {
      files: ['README.md'],
      subject: 'feat: add readme',
    });

    const statusOutput = await git(repoDir, ['status', '--short']);
    const committedContent = await git(repoDir, ['show', 'HEAD:README.md']);

    expect(statusOutput).toBe('');
    expect(committedContent).toBe('formatted\n');
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
        files: ['README.md'],
        subject: 'feat: add',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown).toMatchObject({
      detail: {
        hookFailed: true,
        stderr: expect.stringContaining('hook said no'),
        stdout: expect.any(String),
      },
    });

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
  });
});
