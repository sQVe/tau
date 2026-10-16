import { basename } from 'node:path';

import { runCommand } from '../../command.js';
import { errorMessage } from '../../errors.js';
import type { Exec } from '../../exec.js';
import { minimumPane, readLayout, rectangle } from '../../herdrLayout.js';
import type { PaneLayout } from '../../herdrLayout.js';
import { requireObject, result, terminalLocation, text } from '../../terminal.js';
import { reviewPlacement } from './reviewDecisions.js';
import type { ReviewPlacement } from './reviewDecisions.js';

export interface PaneRequest {
  exec: Exec;
  cwd: string;
  // The pane the agent runs in. The review opens beside it, or in a new tab when it is narrow.
  agentPane: string;
  stagingDirectory: string;
  command: string;
  signal: AbortSignal | undefined;
}

interface ReviewSurface {
  paneId: string;
  close: () => Promise<void>;
}

const quote = (value: string) => `'${value.replaceAll("'", String.raw`'\''`)}'`;

export const tuicrCommand = (stagingDirectory: string): string =>
  `tuicr --file ${quote(stagingDirectory)}`;

const ignoreMissing = (code: string) => (error: unknown) => {
  if (!errorMessage(error).includes(code)) {
    throw error;
  }
};

const agentWidth = (layout: PaneLayout, agentPane: string): number => {
  const found = layout.panes
    .map((pane) => requireObject(pane))
    .find((pane) => pane.pane_id === agentPane);

  if (found === undefined) {
    throw new Error(`Missing herdr layout for pane ${agentPane}.`);
  }

  return rectangle(found.rect).width;
};

// Opens the command in a pane beside the agent, or in a new tab when the agent pane is too narrow
// to split, and waits until it exits. Returns false when the signal aborted the open or the wait.
// A pane or tab that opened closes either way.
export const runInPane = async (request: PaneRequest): Promise<boolean> => {
  const { exec, cwd, signal } = request;

  const herdr = (argumentsList: string[], waitSignal?: AbortSignal) =>
    runCommand({ exec, cwd, signal: waitSignal }, 'herdr', argumentsList, 'herdr');

  const openSplit = async (): Promise<ReviewSurface> => {
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

    // A pane the user already closed is gone, and the review result stands.
    const close = () =>
      herdr(['pane', 'close', paneId]).then(() => undefined, ignoreMissing('pane_not_found'));

    return { paneId, close };
  };

  const openTab = async (layout: PaneLayout): Promise<ReviewSurface> => {
    const created = await herdr(
      [
        'tab',
        'create',
        '--workspace',
        text(layout.workspace_id),
        '--cwd',
        request.stagingDirectory,
        '--label',
        'Draft review',
        '--focus',
      ],
      signal,
    );

    const response = result(created);
    const tabId = text(requireObject(response.tab).tab_id);
    const paneId = text(requireObject(response.root_pane).pane_id);

    // Closing the tab focuses a neighbor, so focus returns to the agent's tab.
    const close = async () => {
      await herdr(['tab', 'close', tabId]).catch(ignoreMissing('tab_not_found'));
      await herdr(['tab', 'focus', text(layout.tab_id)]);
    };

    return { paneId, close };
  };

  const open = async (): Promise<ReviewSurface> => {
    const layout = await readLayout(request.agentPane, (argumentsList) =>
      herdr(argumentsList, signal),
    );

    const width = agentWidth(layout, request.agentPane);

    const placement: ReviewPlacement = reviewPlacement({
      width,
      zoomed: layout.zoomed === true,
      minimumWidth: minimumPane.width,
    });

    return placement === 'right' ? openSplit() : openTab(layout);
  };

  let surface: ReviewSurface;

  try {
    surface = await open();
  } catch (error) {
    if (signal?.aborted === true) {
      return false;
    }

    throw error;
  }

  const { paneId, close } = surface;

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
    await close();
  }
};
