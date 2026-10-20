import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { runCommand } from '../../command.js';
import { errorMessage } from '../../errors.js';
import type { Exec } from '../../exec.js';
import { collectReview } from './collect.js';
import type { Collected } from './collect.js';
import { closeOpened, closePlacement, openReview, runInPane, tuicrCommand } from './herdrReview.js';
import { readReview, removeReview, savePlacement, saveProcessIds, stageReview } from './stage.js';
import type { Review } from './stage.js';
import type { RunTuicr } from './tuicrSession.js';

export interface DraftReviewRuntime {
  exec: Exec;
  // The agent's herdr pane, or undefined outside herdr.
  herdrPaneId: () => string | undefined;
  isProcessRunning: (processId: number) => boolean | Promise<boolean>;
}

type DraftReviewResult =
  | Collected
  | { status: 'manual'; command: string; directory: string }
  | { status: 'opened'; directory: string }
  | { status: 'cancelled'; comments: []; edits: [] };

const parameters = Type.Object({
  action: Type.Union([Type.Literal('review'), Type.Literal('open'), Type.Literal('collect')]),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  directory: Type.Optional(Type.String({ minLength: 1 })),
});

const description = `Show draft files under .tau/ to the user in tuicr. Returns the user's tuicr comments on those files and the edits the user made.
- action review, paths: every path must be a file inside the repository's .tau directory. Paths may be absolute or relative to the working directory. The tool copies the files into a staging directory outside Git, with names relative to .tau/ such as slices/me-328/slice-1.md, and opens that directory in tuicr.
  - Inside herdr: opens tuicr in a pane beside yours when your pane is wide enough to split, or in a new focused tab in your workspace when it is narrow or zoomed. Waits until the user quits tuicr or closes the pane or tab, closes it, focuses your tab again after a tab review, and collects. Returns {status: "reviewed", comments, edits}.
  - Outside herdr: opens nothing. Returns {status: "manual", command, directory}. Tell the user to run command, and to tell you when they are done. Then call collect with directory.
  - If the call is cancelled while tuicr opens or during the wait, the tool closes the pane or tab it opened, deletes no comments, writes no file, removes the staging directory, and returns {status: "cancelled", comments: [], edits: []}.
- action open, paths: stages the files like review and opens tuicr the same way, but without moving focus, and returns at once with {status: "opened", directory}. Ask the user your question, then call collect with directory. Outside herdr it returns {status: "manual", command, directory} like review. If the call is cancelled while tuicr opens, the tool closes what it opened and removes the staging directory.
- action collect, directory: the directory that open or a manual review returned. First closes the tuicr pane or tab that open left, focuses your tab again when the user was in the tuicr tab, and waits until tuicr has exited. If tuicr does not exit within 10 seconds, it deletes no comment, keeps the record, and returns an error that names the record directory. Then collects as below.
- Collect: keeps comments on the reviewed files and deletes exactly those from the tuicr session. It never clears other comments. It returns comments as [{path, startLine, endLine, type, content}] with absolute paths in .tau/. Comments for other files and session-level comments stay in tuicr.
- Edits: each file the user changed gets {path, diff, status}. A file the user did not change gets no entry. Status "applied" means the tool wrote the user's version to the real file. Status "conflict" means the real file changed during the review, so the tool wrote nothing for it. Compare the diff with the file and merge by hand.
- Errors: no paths, a path that is missing, not a file, outside .tau/, inside .tau/draft-review, or a hard link; a directory that is no review record; a missing original copy or a saved path outside the reviewed files (collect deletes no comment and writes no file); a real file that became a link or left .tau/ before its write-back; tuicr output the tool cannot parse (the error names the output). After an error, the staging directory and record stay. A herdr error names the record directory. A collect retry returns the comments and edit outcomes saved by the first try, finishes only the missing deletes and write-backs, and never re-decides an applied edit. Before each write-back the tool compares the real file with the original and reports conflict if it changed.`;

const tuicrRunner =
  (runtime: DraftReviewRuntime, cwd: string, signal: AbortSignal | undefined): RunTuicr =>
  (argumentsList) =>
    runCommand({ exec: runtime.exec, cwd, signal }, 'tuicr', argumentsList, 'tuicr');

const requireDirectory = (directory: string | undefined): string => {
  if (directory === undefined) {
    throw new Error('draft_review action collect needs a directory.');
  }

  return directory;
};

const herdrFailure = (error: unknown, recordDirectory: string): Error =>
  new Error(
    `${errorMessage(error)} The review record is ${recordDirectory}; call collect with it to collect the review.`,
    { cause: error },
  );

const open = async (
  runtime: DraftReviewRuntime,
  cwd: string,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<DraftReviewResult> => {
  const staged = await stageReview(cwd, paths);
  const command = tuicrCommand(staged.stagingDirectory);
  const agentPane = runtime.herdrPaneId();

  if (agentPane === undefined) {
    return { status: 'manual', command, directory: staged.recordDirectory };
  }

  const { exec } = runtime;
  const { stagingDirectory } = staged;
  const request = { exec, cwd, agentPane, stagingDirectory, command, signal };

  try {
    const placement = await openReview(request);

    await savePlacement(staged, placement).catch(async (error: unknown) => {
      await closeOpened(request, placement);

      throw error;
    });
  } catch (error) {
    if (signal?.aborted === true) {
      await removeReview(staged);

      return { status: 'cancelled', comments: [], edits: [] };
    }

    throw herdrFailure(error, staged.recordDirectory);
  }

  return { status: 'opened', directory: staged.recordDirectory };
};

const collect = async (
  runtime: DraftReviewRuntime,
  cwd: string,
  record: Review,
  signal: AbortSignal | undefined,
): Promise<DraftReviewResult> => {
  const { placement } = record;

  if (placement !== null) {
    await closePlacement({
      exec: runtime.exec,
      cwd,
      signal,
      placement,
      savedProcessIds: placement.processIds,
      saveProcessIds: (processIds) => saveProcessIds(record, processIds),
      isProcessRunning: runtime.isProcessRunning,
      recordDirectory: record.recordDirectory,
    });
  }

  return collectReview(tuicrRunner(runtime, cwd, signal), record);
};

const review = async (
  runtime: DraftReviewRuntime,
  cwd: string,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<DraftReviewResult> => {
  const staged = await stageReview(cwd, paths);
  const command = tuicrCommand(staged.stagingDirectory);
  const agentPane = runtime.herdrPaneId();

  if (agentPane === undefined) {
    return { status: 'manual', command, directory: staged.recordDirectory };
  }

  const { exec } = runtime;
  const { stagingDirectory } = staged;
  const request = { exec, cwd, agentPane, stagingDirectory, command, signal };

  const finished = await runInPane(request).catch((error: unknown) => {
    throw herdrFailure(error, staged.recordDirectory);
  });

  if (!finished) {
    await removeReview(staged);

    return { status: 'cancelled', comments: [], edits: [] };
  }

  return collectReview(tuicrRunner(runtime, cwd, signal), staged);
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
      } else if (input.action === 'open') {
        details = await open(runtime, cwd, input.paths ?? [], signal);
      } else {
        details = await review(runtime, cwd, input.paths ?? [], signal);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
