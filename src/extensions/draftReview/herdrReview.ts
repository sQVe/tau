import { basename } from 'node:path';

import { runCommand } from '../../command.js';
import { errorMessage } from '../../errors.js';
import type { Exec } from '../../exec.js';
import { result, terminalLocation } from '../../terminal.js';

export interface PaneRequest {
  exec: Exec;
  cwd: string;
  // The pane the agent runs in. The review pane opens beside it.
  agentPane: string;
  stagingDirectory: string;
  command: string;
  signal: AbortSignal | undefined;
}

const quote = (value: string) => `'${value.replaceAll("'", String.raw`'\''`)}'`;

export const tuicrCommand = (stagingDirectory: string): string =>
  `tuicr --file ${quote(stagingDirectory)}`;

const ignoreMissingPane = (error: unknown): void => {
  if (!errorMessage(error).includes('pane_not_found')) {
    throw error;
  }
};

// Opens the command in a pane beside the agent and waits until it exits. Returns false when the
// signal aborted the wait. The pane closes either way.
export const runInPane = async (request: PaneRequest): Promise<boolean> => {
  const { exec, cwd, signal } = request;

  const herdr = (argumentsList: string[], waitSignal?: AbortSignal) =>
    runCommand({ exec, cwd, signal: waitSignal }, 'herdr', argumentsList, 'herdr');

  const split = await herdr(
    [
      'pane',
      'split',
      '--pane',
      request.agentPane,
      '--direction',
      'right',
      '--cwd',
      request.stagingDirectory,
      '--focus',
    ],
    signal,
  );

  const { paneId } = terminalLocation(result(split).pane);

  // The typed line holds the marker as a printf format and an argument, so only the finished
  // command prints the joined marker.
  const suffix = basename(request.stagingDirectory);
  const marker = `tau-draft-review-done-${suffix}`;
  const line = `${request.command}; printf 'tau-draft-review-done-%s\\n' ${quote(suffix)}`;

  try {
    await herdr(['pane', 'run', paneId, line], signal);
    await herdr(['pane', 'wait-output', paneId, '--match', marker], signal);

    return true;
  } catch (error) {
    if (signal?.aborted === true) {
      return false;
    }

    // The user closed the pane instead of quitting tuicr, which ends the review.
    if (errorMessage(error).includes('pane_not_found')) {
      return true;
    }

    throw error;
  } finally {
    // A pane the user already closed is gone, and the review result stands.
    await herdr(['pane', 'close', paneId]).catch(ignoreMissingPane);
  }
};
