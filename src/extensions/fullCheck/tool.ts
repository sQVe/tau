import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { readCheckIdentity } from '../../checkRecord/identity.js';
import type { Exec } from '../../command.js';
import { configRepositoryKey } from '../../github/repositoryTargetDecisions.js';
import { findTauRoot } from '../../tauDirectory.js';
import type { Recorded } from './checkFlow.js';
import {
  findReusedLog,
  readRepository,
  repositoryLockKey,
  runAndRecord,
  withRepositoryLock,
} from './checkFlow.js';
import { readFullCheckArgv } from './config.js';
import type { CheckResult } from './run.js';

export type FullCheckDetails = Recorded<CheckResult>;

export interface FullCheckToolOptions {
  exec: Exec;
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

const defaultChecksPath = 'checks';
const defaultPollMilliseconds = 500;

const notConfiguredMessage = (repository: string | undefined): string => {
  const unnamed = 'this checkout, whose origin remote does not name a github.com repository,';
  const subject = repository ?? unnamed;

  return `No full check is configured for ${subject}. Run your check as before, with the command the repository documents. To configure one, add fullCheck.repositories.<owner/name>.argv to the user tau.json.`;
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
  const repository = await readRepository({ exec: options.exec, cwd: root, signal });

  const location = {
    cwd: root,
    agentDirectory,
    projectTrusted: context.isProjectTrusted(),
  };

  const configKey = repository === undefined ? undefined : configRepositoryKey(repository);
  const argv = readFullCheckArgv(location, context.ui, configKey);

  if (repository === undefined || configKey === undefined || argv === undefined) {
    throw new Error(notConfiguredMessage(configKey));
  }

  const waiting = await readCheckIdentity(root, argv, base);
  const reusedBeforeWaiting = await findReusedLog(root, waiting, defaultChecksPath);

  if (reusedBeforeWaiting !== undefined) {
    return toToolResult(reusedBeforeWaiting);
  }

  const result = await withRepositoryLock(
    {
      root,
      agentDirectory,
      repository: repositoryLockKey(repository),
      signal,
      pollMilliseconds: options.pollMilliseconds ?? defaultPollMilliseconds,
      notifyWaiting,
    },
    async (recordCommandGroup) => {
      const identity = await readCheckIdentity(root, argv, base);
      const reused = await findReusedLog(root, identity, defaultChecksPath);

      return (
        reused ??
        runAndRecord(
          root,
          identity,
          () => readCheckIdentity(root, argv, base),
          {
            signal,
            recordCommandGroup,
            idleLimitMilliseconds: options.idleLimitMilliseconds,
            checksPath: defaultChecksPath,
            separateStdout: false,
          },
          (checked) => Promise.resolve({ ...checked }),
        )
      );
    },
  );

  return toToolResult(result);
};

export const createFullCheckTool = (
  options: FullCheckToolOptions,
): ToolDefinition<typeof parameters, FullCheckDetails | undefined> =>
  defineTool({
    name: 'full_check',
    label: 'Full check',
    description: `Run the repository's configured full check and save its output. Call it once on the final work state, instead of running the check by hand.
- Optional base: the ref or commit the change is based on. Without it, the origin remote's default branch.
- Returns pass or fail, the exit status, the log path, and the last lines of the output. A failed check is a result, not an error.
- A later call for the same command, head, base, and uncommitted changes returns the saved passing log without a run, and says so.
- Full checks of one repository run one at a time across its checkouts. A waiting call sends an update that names the checkout that holds the lock.
- With no configured entry, the tool errors. Run the repository's check as before.`,
    promptSnippet:
      'Run the repository full check, queued per repository across checkouts, with a saved log.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, toolParameters, signal, onUpdate, context) {
      const notifyWaiting = (message: string) => {
        onUpdate?.({ content: [{ type: 'text', text: message }], details: undefined });
      };

      return execute(options, toolParameters.base, signal, notifyWaiting, context);
    },
  });
