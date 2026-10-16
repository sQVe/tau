import { join } from 'node:path';

import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { errorMessage } from '../../errors.js';
import { readGitOutput } from '../../gitOutput.js';
import { repositoryFromRemote } from '../../repositoryRemote.js';
import { findTauRoot } from '../../tauDirectory.js';
import { readFullCheckArgv } from './config.js';
import { readCheckIdentity } from './identity.js';
import { defaultLockPath, withFullCheckLock } from './queue.js';
import { listSavedLogs, saveCheckRecord } from './record.js';
import { decideReuse, sameReusableState } from './reuseDecision.js';
import type { CheckIdentity } from './reuseDecision.js';
import { readTail, runCheck } from './run.js';
import type { CheckResult } from './run.js';

export type FullCheckDetails = CheckResult & { reused: boolean; recordError?: string };

export interface FullCheckToolOptions {
  agentDirectory?: string;
  pollMilliseconds?: number;
  idleLimitMilliseconds?: number;
}

const parameters = Type.Object({
  base: Type.Optional(
    Type.String({
      description:
        "Ref or commit the change is based on. Defaults to the origin remote's default branch.",
    }),
  ),
});

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

const describeResult = (result: FullCheckDetails): string => {
  const status =
    result.exitCode === null
      ? `signal ${result.signal ?? 'unknown'}`
      : `exit status ${result.exitCode}`;

  const stopped = result.idle
    ? ' The command was stopped because it wrote no output to its log for the idle limit; it was hung.'
    : '';

  const outcome = `Full check ${result.passed ? 'passed' : 'failed'} (${status}).${stopped}`;
  const reuse = result.reused ? ' Reused the saved passing log for this unchanged state.' : '';

  const recordProblem =
    result.recordError === undefined ? '' : ` No reusable record was saved: ${result.recordError}`;

  const headline = `${outcome}${reuse}${recordProblem} Log: ${result.logPath}`;

  return result.tail === '' ? headline : `${headline}\n\nLast lines:\n${result.tail}`;
};

const checksDirectory = (root: string): string => join(root, '.tau', 'checks');

const findReusedLog = async (
  root: string,
  identity: CheckIdentity,
): Promise<FullCheckDetails | undefined> => {
  const decision = decideReuse(identity, await listSavedLogs(checksDirectory(root)));

  if (decision.status === 'run') {
    return undefined;
  }

  const tail = await readTail(decision.logPath);

  return {
    passed: true,
    exitCode: 0,
    signal: null,
    idle: false,
    logPath: decision.logPath,
    tail,
    reused: true,
  };
};

// Runs the check and saves a reusable record only when it passed and its inputs did not change.
const runAndRecord = async (
  root: string,
  identity: CheckIdentity,
  base: string | undefined,
  signal: AbortSignal | undefined,
  recordCommandGroup: (groupId: number) => Promise<void>,
  idleLimitMilliseconds: number | undefined,
): Promise<FullCheckDetails> => {
  const result = await runCheck(
    root,
    identity.argv,
    signal,
    recordCommandGroup,
    idleLimitMilliseconds,
  );

  if (!result.passed) {
    return { ...result, reused: false };
  }

  // A missing record only disables reuse, so a failure to save it never fails a passing check.
  try {
    const after = await readCheckIdentity(root, identity.argv, base);

    if (sameReusableState(identity, after)) {
      await saveCheckRecord(result.logPath, identity);
    }
  } catch (error) {
    return { ...result, reused: false, recordError: errorMessage(error) };
  }

  return { ...result, reused: false };
};

const toToolResult = (result: FullCheckDetails) => ({
  content: [{ type: 'text' as const, text: describeResult(result) }],
  details: result,
});

const execute = async (
  options: FullCheckToolOptions,
  base: string | undefined,
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

  const waiting = await readCheckIdentity(root, argv, base);
  const reusedBeforeWaiting = await findReusedLog(root, waiting);

  if (reusedBeforeWaiting !== undefined) {
    return toToolResult(reusedBeforeWaiting);
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
    async (recordCommandGroup) => {
      const identity = await readCheckIdentity(root, argv, base);
      const reused = await findReusedLog(root, identity);

      return (
        reused ??
        runAndRecord(
          root,
          identity,
          base,
          signal,
          recordCommandGroup,
          options.idleLimitMilliseconds,
        )
      );
    },
  );

  return toToolResult(result);
};

export const createFullCheckTool = (
  options: FullCheckToolOptions = {},
): ToolDefinition<typeof parameters, FullCheckDetails | undefined> =>
  defineTool({
    name: 'full_check',
    label: 'Full check',
    description: `Run the repository's configured full check and save its output.
- Optional base: the ref or commit the change is based on. Without it, the origin remote's default branch.
- The command is fullCheck.repositories.<owner/name>.argv from the user tau.json, run without a shell in the checkout root.
- Only one full check runs at a time on the machine. When another checkout holds the lock, the tool sends an update that names it and waits. Cancelling stops the wait.
- A passing log is saved with the head, base, argv, and a fingerprint of the uncommitted changes. A later call for the same state returns that log without running the command, and says so. Any change to those inputs runs the check again. A failing run, or a run during which the inputs changed, saves nothing for reuse.
- Saves stdout and stderr together as a log under .tau/checks in the checkout.
- Returns pass or fail, the exit status, the log path, and the last lines of the output. A failed check is a result, not an error.
- Errors: no Git checkout, an invalid fullCheck entry for this repository, a command that cannot start, or no configured entry. With no entry, run your check as before.`,
    promptSnippet: 'Run the repository full check, queued across checkouts, with a saved log.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, toolParameters, signal, onUpdate, context) {
      const notifyWaiting = (message: string) => {
        onUpdate?.({ content: [{ type: 'text', text: message }], details: undefined });
      };

      return execute(options, toolParameters.base, signal, notifyWaiting, context);
    },
  });
