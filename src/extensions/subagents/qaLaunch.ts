import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

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

// The command runs without input, so a prompt fails it instead of waiting.
const runUrlCommand = async (
  command: string,
  worktree: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> => {
  const options = { cwd: worktree, timeout: urlCommandTimeoutMilliseconds, signal };
  const running = promisify(execFile)('sh', ['-c', command], options);

  running.child.stdin?.end();

  try {
    const { stdout } = await running;

    return stdout;
  } catch {
    return undefined;
  }
};

// Adds the settings of the launch worktree's repository to a `qa` launch: the app URL from
// `urlCommand` when the caller gave none, and the brief lines. Other launches pass through.
export const applyQaSettings = async (
  parameters: LaunchParameters,
  signal: AbortSignal | undefined,
  context: QaContext,
): Promise<LaunchParameters> => {
  const worktree = resolve(context.cwd, parameters.cwd ?? '.');

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
  const stdout = await runUrlCommand(command, worktree, signal);
  const result = urlCommandResult({ command, source: settings.source, stdout });

  if ('refusal' in result) {
    throw new Error(result.refusal);
  }

  return { ...parameters, task, url: result.url };
};
