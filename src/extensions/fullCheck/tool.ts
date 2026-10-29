import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { readCheckIdentity } from '../../checkRecord/identity.js';
import type { Exec } from '../../command.js';
import { readRepositoryArgv, withIgnoredNote } from '../../config/fullCheck.js';
import { findTauRoot } from '../../tauDirectory.js';
import type { Recorded } from './checkFlow.js';
import {
  findReusedLog,
  readRepository,
  repositoryLockKey,
  runAndRecord,
  withRepositoryLock,
} from './checkFlow.js';
import type { CheckResult } from './run.js';

export type FullCheckDetails = Recorded<CheckResult>;

export interface FullCheckToolOptions {
  exec: Exec;
  agentDirectory?: string;
  pollMilliseconds?: number;
  idleLimitMilliseconds?: number;
}

const parameters = Type.Object({});

const defaultChecksPath = 'checks';
const defaultPollMilliseconds = 500;

const noLockMessage =
  'This checkout has an origin remote that does not name an owner/name repository, so the full check has no lock to share with other checkouts of the repository.';

const notConfiguredMessage = (ignored: string | undefined): string =>
  withIgnoredNote(
    'No full check is configured. Run your check as before, with the command the repository documents. To configure one, add fullCheck.argv to .pi/tau.json in the repository, such as {"fullCheck": {"argv": ["pnpm", "check"]}}.',
    ignored,
  );

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
  signal: AbortSignal | undefined,
  notifyWaiting: (message: string) => void,
  context: Pick<ExtensionToolContext, 'cwd' | 'isProjectTrusted' | 'ui'>,
) => {
  const root = await findTauRoot(context.cwd, 'full_check');
  const agentDirectory = options.agentDirectory ?? getAgentDir();

  const location = {
    cwd: root,
    agentDirectory,
    projectTrusted: context.isProjectTrusted(),
  };

  const { argv, ignored } = readRepositoryArgv(location, context.ui, 'fullCheck');

  if (argv === undefined) {
    throw new Error(notConfiguredMessage(ignored));
  }

  const repository = await readRepository({ exec: options.exec, cwd: root, signal });

  if (repository === undefined) {
    throw new Error(noLockMessage);
  }

  const waiting = await readCheckIdentity(root, argv);
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
      const identity = await readCheckIdentity(root, argv);
      const reused = await findReusedLog(root, identity, defaultChecksPath);

      return (
        reused ??
        runAndRecord(
          root,
          identity,
          () => readCheckIdentity(root, argv),
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
    description: `Run the repository's configured full check and save its output. Call it once on the final work state. After a failure, fix with focused tests and the failing stage before you call it again.
- Returns pass or fail, the exit status, the log path, and the last lines of the output. A failed check is a result, not an error.
- A later call for the same command and file content returns the saved passing log without a run, and says so. A commit or amend that changes no files keeps the file content.
- Full checks of one repository run one at a time across its checkouts. A waiting call sends an update that names the checkout that holds the lock.
- Without fullCheck.argv in .pi/tau.json, it errors. Run the check as before.`,
    promptSnippet:
      'Run the repository full check, queued per repository across checkouts, with a saved log.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, _toolParameters, signal, onUpdate, context) {
      const notifyWaiting = (message: string) => {
        onUpdate?.({ content: [{ type: 'text', text: message }], details: undefined });
      };

      return execute(options, signal, notifyWaiting, context);
    },
  });
