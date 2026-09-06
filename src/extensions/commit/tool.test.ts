import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommitInput } from './tool.js';
import { CommitFailedError, createCommitTool, validatePaths, validateSubject } from './tool.js';

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
        { files: ['README.md'], subject: 'feat: add thing' },
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
      body: 'Initial project file.',
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
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('git commit failed:');
    expect((thrown as Error).message).toContain('hook said no');
    expect(thrown).toMatchObject({
      detail: {
        hookFailed: true,
      },
    });

    expect(thrown).toHaveProperty('detail.stderr', expect.stringContaining('hook said no'));
    expect(thrown).toHaveProperty('detail.stdout', expect.any(String));

    const revListResult = await runCommand('git', ['rev-list', '--all', '--count'], repoDir);
    expect(revListResult.stdout.trim()).toBe('0');
  }, 10_000);

  it('falls back to stdout in the error message when stderr is only whitespace', () => {
    const error = new CommitFailedError('hook output\n', '   \n');

    expect(error.message).toBe('git commit failed: hook output');
    expect(error.detail).toEqual({
      hookFailed: true,
      stdout: 'hook output\n',
      stderr: '   \n',
    });
  });
});

const fakeCommit = (choices: (string | undefined)[], edits: (string | undefined)[] = []) => {
  const previews: string[] = [];
  const custom = vi.fn<
    (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => Promise<string | undefined>
  >(async (factory) => {
    const component = await factory(
      { requestRender: () => {} } as never,
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
    if (args[0] === 'rev-parse') stdout = 'abc123\n';
    return Promise.resolve({ code: 0, killed: false, stderr: '', stdout });
  });
  const tool = createCommitTool({ exec });
  const ctx = { cwd: '/repo', hasUI: true, ui: { custom, editor } };
  const input = {
    files: ['README.md'],
    subject: 'feat: add thing',
    body: 'Original body',
    group: '1/2',
  };
  const execute = (signal?: AbortSignal) =>
    tool.execute('call', input, signal, undefined, ctx as never);
  return { custom, editor, exec, ctx, input, execute, previews };
};

describe('commit overlay flow', () => {
  it('stages and reads numstat before showing the overlay', async () => {
    const { execute, exec, custom, previews } = fakeCommit(['approve']);
    await execute();
    expect(previews[0]).toContain('commit 1/2');
    expect(previews[0]).toContain('README.md +2 -1');
    expect(previews[0]).toContain('image.png +- --');
    expect(exec.mock.calls.slice(0, 3).map((call) => call[1])).toEqual([
      ['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z'],
      ['add', '--', 'README.md'],
      ['diff', '--cached', '--numstat', '--no-renames', '-z', '--', 'README.md'],
    ]);
    expect(exec.mock.invocationCallOrder[2]).toBeLessThan(custom.mock.invocationCallOrder[0] ?? 0);
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
    expect(result.details).toMatchObject({ subject: 'fix: edited', body: 'Edited body' });
  });

  it.each([undefined, 'not conventional'])(
    'retains the subject on cancelled or invalid edits: %s',
    async (edit) => {
      const { execute, custom, previews } = fakeCommit(['subject', 'approve'], [edit]);
      const result = await execute();
      expect(result.details.subject).toBe('feat: add thing');
      if (edit !== undefined) expect(previews[1]).toContain('Invalid subject: not conventional');
      expect(custom).toHaveBeenCalledTimes(2);
    },
  );

  it.each([undefined, ''])('handles a cancelled or empty body edit: %s', async (edit) => {
    const { execute } = fakeCommit(['body', 'approve'], [edit]);
    const result = await execute();
    expect(result.details.body).toBe(edit ?? 'Original body');
  });

  it('opens the body editor with an empty prefill when no body was supplied', async () => {
    const { execute, input, editor } = fakeCommit(['body', 'approve'], [undefined]);
    Reflect.deleteProperty(input, 'body');
    const result = await execute();
    expect(editor).toHaveBeenCalledWith('Edit body', '');
    expect(result.details.body).toBeNull();
  });

  it('unstages skipped groups and returns without committing', async () => {
    const { execute, exec } = fakeCommit(['skip']);
    const result = await execute();
    expect(result.content).toEqual([{ type: 'text', text: 'Commit skipped by user' }]);
    expect(result.details.skipped).toBe(true);
    expect(exec).toHaveBeenLastCalledWith('git', ['reset', '--', 'README.md'], { cwd: '/repo' });
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });

  it.each(['abort', undefined])('unstages and throws on abort or dismissal: %s', async (choice) => {
    const { execute, exec } = fakeCommit([choice]);
    await expect(execute()).rejects.toThrow('Commit declined by user');
    expect(exec).toHaveBeenLastCalledWith('git', ['reset', '--', 'README.md'], { cwd: '/repo' });
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

  it('unstages without opening UI if cancelled while staging', async () => {
    const controller = new AbortController();
    const { execute, exec, custom } = fakeCommit(['approve']);
    exec.mockImplementation((_command, args) => {
      if (args[0] === 'add') controller.abort();
      return Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' });
    });
    await execute(controller.signal);
    expect(custom).not.toHaveBeenCalled();
    expect(exec).toHaveBeenLastCalledWith('git', ['reset', '--', 'README.md'], { cwd: '/repo' });
  });
});
