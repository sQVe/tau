import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { runCommand } from '../../command.js';
import type { Exec } from '../../command.js';
import { errorMessage } from '../../errors.js';
import type { Connect } from '../../hc/connect.js';
import type { HcRuntime } from '../../hc/hc.js';
import { collectReview } from './collect.js';
import type { Collected } from './collect.js';
import {
  endReviewTerminal,
  openReviewTerminal,
  reviewSpace,
  reviewWaitTimeoutSeconds,
  TuicrExitTimeoutError,
  waitForReviewExit,
} from './hcReview.js';
import {
  readReview,
  removeReview,
  saveStartingTerminal,
  saveTerminal,
  stageReview,
} from './stage.js';
import type { Review } from './stage.js';
import type { RunTuicr } from './tuicrSession.js';

export interface DraftReviewRuntime {
  exec: Exec;
  connect: Connect;
}

type DraftReviewResult =
  | Collected
  | { status: 'manual'; command: string; directory: string }
  | { status: 'opened'; directory: string; terminal: string }
  | { status: 'cancelled'; comments: []; edits: [] };

const parameters = Type.Object({
  action: Type.Union([Type.Literal('open'), Type.Literal('collect')]),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  directory: Type.Optional(Type.String({ minLength: 1 })),
});

const description = `Show draft files under .tau/ to the user in tuicr. Returns the user's tuicr comments on those files and the edits the user made.
- action open, paths: every path must be a file inside the repository's .tau directory. Paths may be absolute or relative to the working directory. The tool copies the files into a staging directory outside Git and opens that directory in tuicr. Staged names carry order numbers, such as 01-pr-run-5ASmpd/1-title.md, so tuicr shows them in paths order, grouped by folder. It returns at once. Ask the user your question, then call collect with directory.
  - In a manager terminal: opens tuicr in a new tab of the manager's space. Returns {status: "opened", directory, terminal}, where terminal is the hc address to collect later. The user quits tuicr before answering.
  - Without a manager terminal: opens nothing. Returns {status: "manual", command, directory}. Tell the user to run command, and to tell you when they are done. Then call collect with directory.
  - If the call is cancelled while tuicr opens, the tool ends the terminal it started, removes the staging directory, and returns {status: "cancelled", comments: [], edits: []}.
- action collect, directory: the directory that open returned. Waits until tuicr has exited. If tuicr does not exit, it deletes no comment, keeps the record, and returns an error that names the record directory. Then collects as below.
- Collect: keeps comments on the reviewed files and deletes exactly those from the tuicr session. It never clears other comments. It returns comments as [{path, startLine, endLine, type, content}] with absolute paths in .tau/. Comments for other files and session-level comments stay in tuicr.
- Edits: each file the user changed gets {path, diff, status}. A file the user did not change gets no entry. Status "applied" means the tool wrote the user's version to the real file. Status "conflict" means the real file changed during the review, so the tool wrote nothing for it. Compare the diff with the file and merge by hand.
- Errors: no paths, a path that is missing, not a file, outside .tau/, inside .tau/draft-review, or a hard link; a directory that is no review record; a review record saved by an older Tau that ran on herdr; a missing original copy or a saved path outside the reviewed files (collect deletes no comment and writes no file); a real file that became a link or left .tau/ before its write-back; tuicr output the tool cannot parse (the error names the output). After an error, the staging directory and record stay. An hc error names the record directory. A collect retry returns the comments and edit outcomes saved by the first try, finishes only the missing deletes and write-backs, and never re-decides an applied edit. Before each write-back the tool compares the real file with the original and reports conflict if it changed.`;

const tuicrRunner =
  (runtime: DraftReviewRuntime, cwd: string, signal: AbortSignal | undefined): RunTuicr =>
  (argumentsList) =>
    runCommand({ exec: runtime.exec, cwd, signal }, 'tuicr', argumentsList, 'tuicr');

const quote = (value: string) => `'${value.replaceAll("'", String.raw`'\''`)}'`;

const tuicrCommand = (stagingDirectory: string): string =>
  `tuicr --file ${quote(stagingDirectory)}`;

const hcRuntime = (
  runtime: DraftReviewRuntime,
  cwd: string,
  signal: AbortSignal | undefined,
): HcRuntime => ({
  exec: runtime.exec,
  connect: runtime.connect,
  cwd,
  signal,
});

const requireDirectory = (directory: string | undefined): string => {
  if (directory === undefined) {
    throw new Error('draft_review action collect needs a directory.');
  }

  return directory;
};

const openFailure = (error: unknown, recordDirectory: string): Error =>
  new Error(
    `${errorMessage(error)} The review record is ${recordDirectory}; open a new review after fixing the cause.`,
    { cause: error },
  );

const collectFailure = (error: unknown, recordDirectory: string): Error =>
  new Error(
    `${errorMessage(error)} The review record is ${recordDirectory}; call collect with it again after fixing the cause.`,
    { cause: error },
  );

const cancelledResult = (): DraftReviewResult => ({
  status: 'cancelled',
  comments: [],
  edits: [],
});

const cleanupAbortedOpen = async (
  runtime: DraftReviewRuntime,
  cwd: string,
  staged: Review,
  address: string | undefined,
): Promise<void> => {
  const hc = hcRuntime(runtime, cwd, undefined);

  try {
    if (address !== undefined) {
      await endReviewTerminal(hc, address);
    }

    await removeReview(staged);
  } catch (error) {
    const addressText = address === undefined ? '' : ` and terminal ${address}`;

    throw new Error(
      `${errorMessage(error)} The review record is ${staged.recordDirectory}${addressText}; open a new review or clean up the record before collecting.`,
      { cause: error },
    );
  }
};

const endTerminalAfterSaveFailure = async (
  runtime: DraftReviewRuntime,
  cwd: string,
  staged: Review,
  address: string,
): Promise<void> => {
  try {
    await endReviewTerminal(hcRuntime(runtime, cwd, undefined), address);
  } catch (killError) {
    throw new Error(
      `${errorMessage(killError)} The review record is ${staged.recordDirectory} and terminal ${address}. Quit that terminal, then open a new review.`,
      { cause: killError },
    );
  }
};

const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const open = async (
  runtime: DraftReviewRuntime,
  cwd: string,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<DraftReviewResult> => {
  const staged = await stageReview(cwd, paths);
  const command = tuicrCommand(staged.stagingDirectory);
  const hc = hcRuntime(runtime, cwd, signal);
  let address: string | undefined;
  let result: DraftReviewResult | undefined;
  let failure: unknown;

  try {
    const space = await reviewSpace(hc);

    if (space === undefined) {
      result = { status: 'manual', command, directory: staged.recordDirectory };
    } else {
      await saveStartingTerminal(staged);

      address = await openReviewTerminal(hcRuntime(runtime, cwd, undefined), {
        stagingDirectory: staged.stagingDirectory,
        space,
      });

      await saveTerminal(staged, address);

      result = { status: 'opened', directory: staged.recordDirectory, terminal: address };
    }
  } catch (error) {
    failure = error;
  }

  if (aborted(signal)) {
    await cleanupAbortedOpen(runtime, cwd, staged, address);

    return cancelledResult();
  }

  if (failure !== undefined) {
    if (address !== undefined) {
      await endTerminalAfterSaveFailure(runtime, cwd, staged, address);
    }

    throw openFailure(failure, staged.recordDirectory);
  }

  if (result === undefined) {
    throw new Error(`draft_review open finished without a result for ${staged.recordDirectory}.`);
  }

  return result;
};

const collect = async (
  runtime: DraftReviewRuntime,
  cwd: string,
  record: Review,
  signal: AbortSignal | undefined,
): Promise<DraftReviewResult> => {
  if (record.terminal?.state === 'starting') {
    throw new Error(
      `The review record ${record.recordDirectory} was left while tuicr was starting, so its hc address is missing. Quit tuicr, then open a new review.`,
    );
  }

  if (record.terminal?.state === 'open') {
    await waitForReviewExit(hcRuntime(runtime, cwd, signal), {
      address: record.terminal.address,
      recordDirectory: record.recordDirectory,
      timeoutSeconds: reviewWaitTimeoutSeconds,
    }).catch((error: unknown) => {
      if (error instanceof TuicrExitTimeoutError) {
        throw error;
      }

      throw collectFailure(error, record.recordDirectory);
    });
  }

  return collectReview(tuicrRunner(runtime, cwd, signal), record);
};

export const createDraftReviewTool = (
  runtime: DraftReviewRuntime,
): ToolDefinition<typeof parameters, DraftReviewResult> =>
  defineTool({
    name: 'draft_review',
    label: 'Draft review',
    description,
    promptSnippet: 'Show draft files under .tau/ to the user in tuicr and collect their feedback.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      const { cwd } = context;
      let details: DraftReviewResult;

      if (input.action === 'collect') {
        const record = await readReview(cwd, requireDirectory(input.directory));

        details = await collect(runtime, cwd, record, signal);
      } else {
        details = await open(runtime, cwd, input.paths ?? [], signal);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
