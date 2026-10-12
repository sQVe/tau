import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { readGitOutput } from '../../gitOutput.js';
import { repositoryFromRemote } from '../../repositoryRemote.js';
import { findTauRoot } from '../../tauDirectory.js';
import { readFullCheckArgv } from './config.js';
import { defaultLockPath, withFullCheckLock } from './queue.js';
import { runCheck } from './run.js';
import type { CheckResult } from './run.js';

export interface FullCheckToolOptions {
  agentDirectory?: string;
  pollMilliseconds?: number;
}

const parameters = Type.Object({});

const defaultPollMilliseconds = 500;

const notConfiguredMessage = (repository: string | undefined): string => {
  const unnamed = 'this checkout, whose origin remote does not name an owner/name repository,';
  const subject = repository ?? unnamed;

  return `No full check is configured for ${subject}. Run your check as before, with the command the repository documents. To configure one, add fullCheck.repositories.<owner/name>.argv to the user tau.json.`;
};

const readRepository = async (root: string): Promise<string | undefined> => {
  const output = await readGitOutput(root, ['remote', 'get-url', 'origin']);

  return output === undefined ? undefined : repositoryFromRemote(output);
};

const describeResult = (result: CheckResult): string => {
  const status =
    result.exitCode === null
      ? `signal ${result.signal ?? 'unknown'}`
      : `exit status ${result.exitCode}`;

  const headline = `Full check ${result.passed ? 'passed' : 'failed'} (${status}). Log: ${result.logPath}`;

  return result.tail === '' ? headline : `${headline}\n\nLast lines:\n${result.tail}`;
};

const execute = async (
  options: FullCheckToolOptions,
  signal: AbortSignal | undefined,
  notifyWaiting: (message: string) => void,
  context: Pick<ExtensionToolContext, 'cwd' | 'isProjectTrusted' | 'ui'>,
) => {
  const root = await findTauRoot(context.cwd, 'full_check');
  const agentDirectory = options.agentDirectory ?? getAgentDir();
  const repository = await readRepository(root);

  const location = {
    cwd: root,
    agentDirectory,
    projectTrusted: context.isProjectTrusted(),
  };

  const argv = readFullCheckArgv(location, context.ui, repository);

  if (argv === undefined) {
    throw new Error(notConfiguredMessage(repository));
  }

  const result = await withFullCheckLock(
    {
      lockPath: defaultLockPath(agentDirectory),
      checkout: root,
      signal,
      pollMilliseconds: options.pollMilliseconds ?? defaultPollMilliseconds,
      onWaiting: (holder) => {
        const holderName = holder === undefined ? 'another checkout' : holder.checkout;

        notifyWaiting(`Waiting for the full check running in ${holderName} to finish.`);
      },
    },
    () => runCheck(root, argv, signal),
  );

  return { content: [{ type: 'text' as const, text: describeResult(result) }], details: result };
};

export const createFullCheckTool = (
  options: FullCheckToolOptions = {},
): ToolDefinition<typeof parameters, CheckResult | undefined> =>
  defineTool({
    name: 'full_check',
    label: 'Full check',
    description: `Run the repository's configured full check and save its output.
- No parameters. The command is fullCheck.repositories.<owner/name>.argv from the user tau.json, run without a shell in the checkout root.
- Only one full check runs at a time on the machine. When another checkout holds the lock, the tool sends an update that names it and waits. Cancelling stops the wait.
- Saves stdout and stderr together as a log under .tau/checks in the checkout.
- Returns pass or fail, the exit status, the log path, and the last lines of the output. A failed check is a result, not an error.
- Errors: no Git checkout, an invalid fullCheck entry for this repository, a command that cannot start, or no configured entry. With no entry, run your check as before.`,
    promptSnippet: 'Run the repository full check, queued across checkouts, with a saved log.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, _parameters, signal, onUpdate, context) {
      const notifyWaiting = (message: string) => {
        onUpdate?.({ content: [{ type: 'text', text: message }], details: undefined });
      };

      return execute(options, signal, notifyWaiting, context);
    },
  });
