import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { readGitOutput } from '../../gitOutput.js';
import { repositoryFromRemote } from '../../repositoryRemote.js';
import type { LaunchParameters } from './launchParameters.js';
import { requireSessionCwd } from './loadout.js';
import { briefWithQaLines, qaBriefLines, urlCommandResult } from './qaBrief.js';
import { readQaSettings } from './qaSettings.js';

type QaContext = Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'ui'>;

const urlCommandTimeoutMilliseconds = 15_000;
const urlCommandOutputLimitBytes = 1_048_576;

// The command runs without input, so a prompt fails it instead of waiting. It runs in its own
// process group, and the deadline or an abort kills the whole group and settles the result at once,
// even when the command ignores SIGTERM.
const runUrlCommand = (
  command: string,
  worktree: string,
  signal: AbortSignal | undefined,
  timeoutMilliseconds: number,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const deadline = AbortSignal.timeout(timeoutMilliseconds);
    const stopSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

    const child = spawn('sh', ['-c', command], {
      cwd: worktree,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const chunks: Buffer[] = [];
    let outputBytes = 0;

    const kill = (): void => {
      if (child.pid === undefined) {
        return;
      }

      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group already exited.
      }
    };

    const stop = (): void => {
      kill();
      stopSignal.removeEventListener('abort', stop);
      resolve(undefined);
    };

    const finish = (stdout: string | undefined): void => {
      stopSignal.removeEventListener('abort', stop);
      resolve(stdout);
    };

    if (stopSignal.aborted) {
      stop();

      return;
    }

    stopSignal.addEventListener('abort', stop, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;

      if (outputBytes > urlCommandOutputLimitBytes) {
        stop();

        return;
      }

      chunks.push(chunk);
    });

    child.on('error', () => {
      finish(undefined);
    });

    child.on('close', (code) => {
      finish(code === 0 ? Buffer.concat(chunks).toString() : undefined);
    });
  });

// Adds the settings of the launch worktree's repository to a `qa` launch: the app URL from
// `urlCommand` when the caller gave none, and the brief lines. Other launches pass through.
export const applyQaSettings = async (
  parameters: LaunchParameters,
  signal: AbortSignal | undefined,
  context: QaContext,
  urlCommandTimeout = urlCommandTimeoutMilliseconds,
): Promise<LaunchParameters> => {
  const worktree = resolvePath(context.cwd, parameters.cwd ?? '.');

  if (parameters.profile !== 'qa' || !existsSync(worktree)) {
    return parameters;
  }

  // The command runs checkout code, so only the session's own cwd may reach it.
  requireSessionCwd(context, parameters.cwd);

  const originOutput = await readGitOutput(worktree, ['remote', 'get-url', 'origin']);
  const originUrl = originOutput?.trim();
  const repository = originUrl === undefined ? undefined : repositoryFromRemote(originUrl);

  const settings = readQaSettings(
    { cwd: worktree, agentDirectory: getAgentDir(), projectTrusted: context.isProjectTrusted() },
    context.ui,
    repository,
  );

  if (settings === undefined) {
    return parameters;
  }

  const task = briefWithQaLines(parameters.task, qaBriefLines(settings));

  if (parameters.url !== undefined || settings.urlCommand === undefined) {
    return { ...parameters, task };
  }

  const command = settings.urlCommand;
  const stdout = await runUrlCommand(command, worktree, signal, urlCommandTimeout);
  const result = urlCommandResult({ command, source: settings.source, stdout });

  if ('refusal' in result) {
    throw new Error(result.refusal);
  }

  return { ...parameters, task, url: result.url };
};
