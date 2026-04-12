import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ToolCallEvent, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { commitGuardReason, guardToolCall } from './guard.js';
import commitExtension from './index.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
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
  const repoDir = await mkdtemp(join(tmpdir(), 'tau-commit-guard-'));
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

describe('guardToolCall', () => {
  it('returns undefined for non-bash tool calls', async () => {
    await expect(guardToolCall(makeReadEvent())).resolves.toBeUndefined();
  });

  it.each(['git status', 'git diff HEAD', 'git log --oneline', 'git add src/foo.ts'])(
    'returns undefined for bash commands that are not git-commit invocations: %s',
    async (command) => {
      await expect(guardToolCall(makeBashEvent(command))).resolves.toBeUndefined();
    },
  );

  it('returns a block result for a plain git commit bash command', async () => {
    await expect(guardToolCall(makeBashEvent("git commit -m 'feat: add'"))).resolves.toEqual({
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
  ])('blocks the positive corpus: %s', async (command) => {
    await expect(guardToolCall(makeBashEvent(command))).resolves.toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each(["sh -c 'git commit -m x'", "bash -c 'git commit -m x'"])(
    'blocks shell eval commands containing commit invocations via literal-substring check: %s',
    async (command) => {
      await expect(guardToolCall(makeBashEvent(command))).resolves.toEqual({
        block: true,
        reason: commitGuardReason,
      });
    },
  );

  it.each([
    "sh -c 'git status'",
    "bash -c 'echo hello'",
    "echo 'git commit -m x' && bash -c 'echo hello'",
  ])('does not block shell eval commands without commit invocations: %s', async (command) => {
    await expect(guardToolCall(makeBashEvent(command))).resolves.toBeUndefined();
  });

  it('does not block pipe-to-grep patterns mentioning commit', async () => {
    await expect(guardToolCall(makeBashEvent('git log | grep commit'))).resolves.toBeUndefined();
  });
});

describe('commitExtension', () => {
  it("registers the guard in index.ts and does not affect the tool's own git invocations", async () => {
    const repoDir = await createTempRepo();
    await writeRepoFile(repoDir, 'README.md', 'hello\n');

    let registeredTool: ToolDefinition | undefined;
    const registeredHandlers: Record<string, ((...args: never[]) => unknown)[]> = {};

    const fakePi = {
      exec(command: string, args: string[], options?: { cwd?: string }) {
        return runCommand(command, args, options?.cwd ?? repoDir);
      },
      on(eventName: string, handler: (...args: never[]) => unknown) {
        registeredHandlers[eventName] ??= [];
        registeredHandlers[eventName].push(handler);
      },
      registerTool(tool: ToolDefinition) {
        registeredTool = tool;
      },
    } as unknown as ExtensionAPI;

    commitExtension(fakePi);

    expect(registeredTool).toBeDefined();
    expect(registeredHandlers.tool_call).toHaveLength(1);
    expect(registeredHandlers.tool_call?.[0]).toBe(guardToolCall);

    if (registeredTool == null) {
      throw new Error('Expected commit tool to be registered');
    }

    const result = await registeredTool.execute(
      'tool-call-1',
      { files: ['README.md'], subject: 'feat: add thing' },
      undefined,
      undefined,
      { cwd: repoDir } as never,
    );

    const commitCountOutput = await git(repoDir, ['rev-list', '--all', '--count']);
    const commitCount = commitCountOutput.trim();
    expect(commitCount).toBe('1');
    expect(result.details).toMatchObject({
      files: ['README.md'],
      subject: 'feat: add thing',
    });
  });
});
