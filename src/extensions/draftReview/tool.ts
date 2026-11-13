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
import type { ReviewTerminalRequest } from './hcReview.js';
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

const description = `Review .tau/ drafts in tuicr.
- open {paths}: absolute or relative file paths inside .tau/, in review order. Returns immediately: {status:opened,directory,terminal} in a manager terminal (terminal: hc address), otherwise {status:manual,command,directory}; manual opens nothing. Cancellation: {status:cancelled,comments:[],edits:[]}.
- collect {directory}: use open's directory after the user's answer. Ends tuicr; returns {status:reviewed,comments,edits}. comments: [{path,startLine,endLine,type,content}], with absolute .tau/ paths. edits: [{path,diff,status}] for changed files only. applied: user's version written to the real file; conflict: real file changed during review, nothing written for it.`;

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

const reviewLaunchTimeoutMilliseconds = 15_000;

class ReviewLaunchTimeoutError extends Error {
  override name = 'ReviewLaunchTimeoutError';
}

const launchReviewTerminal = async (
  runtime: DraftReviewRuntime,
  cwd: string,
  request: ReviewTerminalRequest,
): Promise<string> => {
  const launchController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new ReviewLaunchTimeoutError(
          `hc run did not start a terminal within ${reviewLaunchTimeoutMilliseconds} ms.`,
        ),
      );

      launchController.abort();
    }, reviewLaunchTimeoutMilliseconds);
  });

  // The caller's signal stays off hc run, so an abort still learns the address of a terminal that started.
  const launch = openReviewTerminal(hcRuntime(runtime, cwd, launchController.signal), request);

  try {
    return await Promise.race([launch, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

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

      address = await launchReviewTerminal(runtime, cwd, {
        stagingDirectory: staged.stagingDirectory,
        space,
      });

      await saveTerminal(staged, address);

      result = { status: 'opened', directory: staged.recordDirectory, terminal: address };
    }
  } catch (error) {
    failure = error;
  }

  if (failure instanceof ReviewLaunchTimeoutError) {
    throw openFailure(failure, staged.recordDirectory);
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

const endAndWaitForReview = async (
  hc: HcRuntime,
  address: string,
  recordDirectory: string,
): Promise<void> => {
  await endReviewTerminal(hc, address);

  await waitForReviewExit(hc, {
    address,
    recordDirectory,
    timeoutSeconds: reviewWaitTimeoutSeconds,
  });
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
    await endAndWaitForReview(
      hcRuntime(runtime, cwd, signal),
      record.terminal.address,
      record.recordDirectory,
    ).catch((error: unknown) => {
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
