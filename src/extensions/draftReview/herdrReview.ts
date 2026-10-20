import { basename } from 'node:path';

import { runCommand } from '../../command.js';
import { errorMessage } from '../../errors.js';
import type { Exec } from '../../exec.js';
import { minimumPane, readLayout, rectangle } from '../../herdrLayout.js';
import type { PaneLayout } from '../../herdrLayout.js';
import { findTerminal, requireObject, result, terminalLocation, text } from '../../terminal.js';
import type { TerminalLocation } from '../../terminal.js';
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
  // A pane ID can change when the user moves the terminal, so the surface keeps the terminal ID.
  terminalId: string;
  // Closes the surface from the terminal's current location.
  close: (location: TerminalLocation) => Promise<void>;
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

  const closePane = (paneId: string) =>
    herdr(['pane', 'close', paneId]).then(() => undefined, ignoreMissing('pane_not_found'));

  const locate = (terminalId: string, waitSignal?: AbortSignal) =>
    findTerminal(terminalId, (argumentsList) => herdr(argumentsList, waitSignal));

  // Runs a herdr action at the terminal's current pane. A pane_not_found either means the user
  // closed the terminal or moved it to a new pane ID, so the action is tried again there. Returns
  // false when the terminal is gone.
  const atTerminal = async (
    terminalId: string,
    action: (paneId: string) => Promise<unknown>,
  ): Promise<boolean> => {
    let location = await locate(terminalId, signal);

    while (location !== undefined) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Each try follows the terminal to its new pane.
        await action(location.paneId);

        return true;
      } catch (error) {
        if (!errorMessage(error).includes('pane_not_found')) {
          throw error;
        }
      }

      const previous: TerminalLocation = location;

      // oxlint-disable-next-line no-await-in-loop -- Resolve again after each lost pane.
      location = await locate(terminalId, signal);

      // A terminal still listed at the pane that was not found has no new pane to act at.
      if (location?.paneId === previous.paneId) {
        return false;
      }
    }

    return false;
  };

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

    const { terminalId } = terminalLocation(result(split).pane);

    // A pane the user already closed is gone, and the review result stands.
    const close = (location: TerminalLocation) => closePane(location.paneId);

    return { terminalId, close };
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
    const terminalId = text(requireObject(response.root_pane).terminal_id);

    // Closing the tab focuses a neighbor, so focus returns to the agent's tab. A terminal the user
    // moved out of the tab closes alone, and the tabs stay as they are.
    const close = async (location: TerminalLocation) => {
      if (location.tabId !== tabId) {
        await closePane(location.paneId);

        return;
      }

      await herdr(['tab', 'close', tabId]).catch(ignoreMissing('tab_not_found'));
      await herdr(['tab', 'focus', text(layout.tab_id)]);
    };

    return { terminalId, close };
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

  const { terminalId, close } = surface;

  // The typed line holds the marker as a printf format and an argument, so only the finished
  // command prints the joined marker.
  const suffix = basename(request.stagingDirectory);
  const marker = `tau-draft-review-done-${suffix}`;
  const line = `${request.command}; printf 'tau-draft-review-done-%s\\n' ${quote(suffix)}`;

  try {
    const started = await atTerminal(terminalId, (paneId) =>
      herdr(['pane', 'run', paneId, line], signal),
    );

    // A terminal the user closed before or during the review ends it.
    if (started) {
      await atTerminal(terminalId, (paneId) =>
        herdr(['pane', 'wait-output', paneId, '--match', marker], signal),
      );
    }

    return true;
  } catch (error) {
    if (signal?.aborted === true) {
      return false;
    }

    throw error;
  } finally {
    const remaining = await locate(terminalId);

    if (remaining !== undefined) {
      await close(remaining);
    }
  }
};
