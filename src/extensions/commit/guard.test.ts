import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ToolCallEvent, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as commentReview from './commentReview.js';
import { commitGuardReason, guardToolCall } from './guard.js';
import commitExtension from './index.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const makeReadEvent = (): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'tool-call-1',
  toolName: 'read',
  input: { path: 'README.md' },
});

const makeBashEvent = (command: string): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'tool-call-1',
  toolName: 'bash',
  input: { command },
});

const runCommand = async (
  command: string,
  commandArguments: string[],
  workingDirectory: string,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArguments, {
      cwd: workingDirectory,
    });

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

const git = async (repositoryDirectory: string, commandArguments: string[]): Promise<string> => {
  const result = await runCommand('git', commandArguments, repositoryDirectory);

  if (result.code !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
};

const createTemporaryRepository = async (): Promise<string> => {
  const repositoryDirectory = await mkdtemp(join(tmpdir(), 'tau-commit-guard-'));
  temporaryDirectories.push(repositoryDirectory);

  await git(repositoryDirectory, ['init']);
  await git(repositoryDirectory, ['config', 'user.name', 'Tau Test']);
  await git(repositoryDirectory, ['config', 'user.email', 'tau@example.com']);
  await git(repositoryDirectory, ['config', 'commit.gpgsign', 'false']);

  return repositoryDirectory;
};

const writeRepositoryFile = async (
  repositoryDirectory: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const fullPath = join(repositoryDirectory, relativePath);

  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
};

describe('guardToolCall', () => {
  it('returns undefined for non-bash tool calls', () => {
    expect(guardToolCall(makeReadEvent())).toBeUndefined();
  });

  it.each(['git status', 'git diff HEAD', 'git log --oneline', 'git add src/foo.ts'])(
    'allows bash commands that do not run git commit: %s',
    (command) => {
      expect(guardToolCall(makeBashEvent(command))).toBeUndefined();
    },
  );

  it('returns a block result for a plain git commit bash command', () => {
    expect(guardToolCall(makeBashEvent("git commit -m 'feat: add'"))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each([
    "git commit --amend -m 'fix: typo'",
    "git add . && git commit -m 'x'",
    "echo $(git commit -m 'x')",
    "(git commit -m 'x')",
    "git-commit -m 'feat: add'",
  ])('blocks commands that create commits: %s', (command) => {
    expect(guardToolCall(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each([
    "sh -c 'git commit -m x'",
    "bash -c 'git commit -m x'",
    "sh -lc 'git commit -m x'",
    "bash -lc 'git commit -m x'",
    "bash -c   'git commit -m x'",
    "bash -c $'git commit -m x'",
  ])('blocks shell commands that contain git commit: %s', (command) => {
    expect(guardToolCall(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each(["sh -c 'git status'", "bash -c 'echo hello'"])(
    'allows shell commands without git commit: %s',
    (command) => {
      expect(guardToolCall(makeBashEvent(command))).toBeUndefined();
    },
  );

  it.each([
    'GIT_DIR=.git git commit -m x',
    "eval 'git commit -m x'",
    'command git commit -m x',
    'env git commit -m x',
    'xargs git commit -m x',
    'bash --norc -c "git commit -m x"',
    'git -C /tmp/repo commit -m x',
    'git -c user.name=x commit -m x',
  ])('blocks invocations that a command-name check misses: %s', (command) => {
    expect(guardToolCall(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('does not block pipe-to-grep patterns mentioning commit', () => {
    expect(guardToolCall(makeBashEvent('git log | grep commit'))).toBeUndefined();
  });

  it.each([
    'git diff src/extensions/commit/guard.ts',
    'git add skills/commit/SKILL.md',
    'git log -- src/extensions/commit',
    'git checkout src/extensions/commit/tool.ts',
    'git status src/extensions/commit/',
  ])('does not block git commands whose paths contain commit: %s', (command) => {
    expect(guardToolCall(makeBashEvent(command))).toBeUndefined();
  });

  it.each([
    'git commit-tree $tree -p HEAD -m x',
    "git update-ref HEAD $(git commit-tree $tree -p HEAD -m 'feat: x')",
  ])('blocks plumbing commands that create commits: %s', (command) => {
    expect(guardToolCall(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each(['g\\it c\\ommit -m x', 'git co""mmit -m x', "g''it commit -m x", 'git \\commit -m x'])(
    'blocks git commit with shell escapes or empty quotes: %s',
    (command) => {
      expect(guardToolCall(makeBashEvent(command))).toEqual({
        block: true,
        reason: commitGuardReason,
      });
    },
  );

  it('blocks a commit split across a line continuation', () => {
    expect(guardToolCall(makeBashEvent("git \\\n  commit -m 'feat: x'"))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });
});

describe('commitExtension', () => {
  interface CommandEntry {
    description?: string;
    handler: (commandArguments: string, context: { isIdle(): boolean }) => Promise<void>;
  }

  const createFakePi = (executeCommand?: ExtensionAPI['exec']) => {
    let registeredTool: ToolDefinition | undefined;
    const registeredHandlers: Record<string, ((...commandArguments: never[]) => unknown)[]> = {};
    const registeredCommands = new Map<string, CommandEntry>();
    const sentUserMessages: { content: string; options?: { deliverAs?: string } }[] = [];

    const fakePi = {
      exec: executeCommand ?? (() => Promise.reject(new Error('not wired'))),
      registerFlag: vi.fn<ExtensionAPI['registerFlag']>(),
      getFlag: vi.fn<ExtensionAPI['getFlag']>().mockReturnValue(false),
      on(eventName: string, handler: (...commandArguments: never[]) => unknown) {
        registeredHandlers[eventName] ??= [];
        registeredHandlers[eventName].push(handler);
      },
      registerTool(tool: ToolDefinition) {
        registeredTool = tool;
      },
      registerCommand(name: string, command: CommandEntry) {
        registeredCommands.set(name, command);
      },
      sendUserMessage(content: string, options?: { deliverAs?: string }) {
        sentUserMessages.push(options == null ? { content } : { content, options });
      },
    } as unknown as ExtensionAPI;

    return {
      fakePi,
      registeredTool: () => registeredTool,
      registeredHandlers,
      registeredCommands,
      sentUserMessages,
    };
  };

  it('registers the guard, tool, and command', () => {
    const { fakePi, registeredTool, registeredHandlers, registeredCommands } = createFakePi();

    commitExtension(fakePi);

    expect(registeredTool()).toBeDefined();
    expect(registeredHandlers.tool_call).toHaveLength(1);
    expect(registeredHandlers.tool_call?.[0]).toBe(guardToolCall);
    expect(registeredCommands.has('commit')).toBe(true);
  });

  it('reads commit preapproval from the CLI flag at execution time', async () => {
    const reviewer = vi.spyOn(commentReview, 'reviewComments').mockResolvedValue({ findings: [] });
    const repositoryDirectory = await createTemporaryRepository();
    const { fakePi, registeredTool } = createFakePi((command, commandArguments, options) =>
      runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
    );
    const custom = vi.fn<() => Promise<string>>().mockResolvedValue('abort');

    commitExtension(fakePi);

    expect(fakePi.registerFlag).toHaveBeenCalledWith('auto-approve-commits', {
      description:
        'Skip commit confirmation for this process. Checks and comment review still apply.',
      type: 'boolean',
      default: false,
    });
    vi.mocked(fakePi.getFlag).mockImplementation((name) => name === 'auto-approve-commits');

    try {
      for (const hasUI of [true, false]) {
        const file = hasUI ? 'interactive.txt' : 'headless.txt';

        await writeRepositoryFile(repositoryDirectory, file, 'hello\n');

        const result = await registeredTool()!.execute(
          'call',
          { groups: [{ files: [file], subject: 'feat: add file' }] },
          undefined,
          undefined,
          { cwd: repositoryDirectory, hasUI, ui: { custom } } as never,
        );

        expect(result.details).toMatchObject({
          groups: [{ files: [file], commentReview: { status: 'passed' } }],
        });
      }

      expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('2');
      expect(reviewer).toHaveBeenCalledTimes(2);
      expect(custom).not.toHaveBeenCalled();
    } finally {
      reviewer.mockRestore();
    }
  });

  it('sends skill messages as follow-ups when idle and steering messages when busy', async () => {
    const { fakePi, registeredCommands, sentUserMessages } = createFakePi();

    commitExtension(fakePi);

    const commitCommand = registeredCommands.get('commit');

    if (commitCommand == null) {
      throw new Error('Expected commit command to be registered');
    }

    await commitCommand.handler('--scope auth', { isIdle: () => true });
    await commitCommand.handler('', { isIdle: () => true });
    await commitCommand.handler('--scope auth', { isIdle: () => false });

    expect(sentUserMessages).toEqual([
      {
        content: '/skill:commit --scope auth',
        options: { deliverAs: 'followUp' },
      },
      {
        content: '/skill:commit',
        options: { deliverAs: 'followUp' },
      },
      {
        content: '/skill:commit --scope auth',
        options: { deliverAs: 'steer' },
      },
    ]);
  });

  it("does not affect the tool's own git invocations", async () => {
    const reviewer = vi.spyOn(commentReview, 'reviewComments').mockResolvedValue({ findings: [] });
    const repositoryDirectory = await createTemporaryRepository();
    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    const executeCommand: ExtensionAPI['exec'] = (
      command: string,
      commandArguments: string[],
      options?: { cwd?: string },
    ) => runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
    const { fakePi, registeredTool } = createFakePi(executeCommand);

    commitExtension(fakePi);

    const tool = registeredTool();

    if (tool == null) {
      throw new Error('Expected commit tool to be registered');
    }

    const result = await tool.execute(
      'tool-call-1',
      { groups: [{ files: ['README.md'], subject: 'feat: add thing' }] },
      undefined,
      undefined,
      {
        cwd: repositoryDirectory,
        hasUI: true,
        ui: { custom: () => Promise.resolve('approve') },
      } as never,
    );

    const commitCountOutput = await git(repositoryDirectory, ['rev-list', '--all', '--count']);
    const commitCount = commitCountOutput.trim();

    expect(commitCount).toBe('1');
    expect(result.details).toMatchObject({
      groups: [{ files: ['README.md'], subject: 'feat: add thing' }],
    });

    reviewer.mockRestore();
  });
});
