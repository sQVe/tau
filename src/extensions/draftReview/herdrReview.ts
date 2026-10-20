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

type HerdrCall = (argumentsList: string[], waitSignal?: AbortSignal) => Promise<string>;

export interface PaneRequest {
  exec: Exec;
  cwd: string;
  // The pane the agent runs in. The review opens beside it, or in a new tab when it is narrow.
  agentPane: string;
  stagingDirectory: string;
  command: string;
  signal: AbortSignal | undefined;
}

// Where the review opened. A pane ID can change when the user moves the terminal, so it keeps the
// terminal ID.
export type OpenedPlacement =
  | { kind: 'split'; terminalId: string }
  | { kind: 'tab'; terminalId: string; tabId: string; agentTabId: string };

export interface CloseRequest {
  exec: Exec;
  cwd: string;
  signal: AbortSignal | undefined;
  placement: OpenedPlacement;
  isProcessRunning: (processId: number) => boolean | Promise<boolean>;
  // Names the review record in a wait error.
  recordDirectory: string;
}

const exitPollMilliseconds = 100;
const exitPollLimit = 100;

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

const herdrCaller =
  (request: { exec: Exec; cwd: string; signal: AbortSignal | undefined }): HerdrCall =>
  (argumentsList, waitSignal) =>
    runCommand(
      { exec: request.exec, cwd: request.cwd, signal: waitSignal },
      'herdr',
      argumentsList,
      'herdr',
    );

const closePane = (herdr: HerdrCall, paneId: string) =>
  herdr(['pane', 'close', paneId]).then(() => undefined, ignoreMissing('pane_not_found'));

const splitArguments = (request: PaneRequest, focus: boolean): string[] => {
  const argumentsList = [
    'pane',
    'split',
    '--pane',
    request.agentPane,
    '--direction',
    'right',
    '--cwd',
    request.stagingDirectory,
  ];

  if (focus) {
    argumentsList.push('--focus');
  }

  return argumentsList;
};

const tabArguments = (request: PaneRequest, layout: PaneLayout, focus: boolean): string[] => {
  const argumentsList = [
    'tab',
    'create',
    '--workspace',
    text(layout.workspace_id),
    '--cwd',
    request.stagingDirectory,
    '--label',
    'Draft review',
  ];

  if (focus) {
    argumentsList.push('--focus');
  }

  return argumentsList;
};

const openSplit = async (
  herdr: HerdrCall,
  request: PaneRequest,
  focus: boolean,
): Promise<OpenedPlacement> => {
  const split = await herdr(splitArguments(request, focus), request.signal);
  const { terminalId } = terminalLocation(result(split).pane);

  return { kind: 'split', terminalId };
};

const openTab = async (
  herdr: HerdrCall,
  request: PaneRequest,
  layout: PaneLayout,
  focus: boolean,
): Promise<OpenedPlacement> => {
  const created = await herdr(tabArguments(request, layout, focus), request.signal);
  const response = result(created);
  const tabId = text(requireObject(response.tab).tab_id);
  const terminalId = text(requireObject(response.root_pane).terminal_id);

  return { kind: 'tab', terminalId, tabId, agentTabId: text(layout.tab_id) };
};

const openPlacement = async (
  herdr: HerdrCall,
  request: PaneRequest,
  focus: boolean,
): Promise<OpenedPlacement> => {
  const layout = await readLayout(request.agentPane, (argumentsList) =>
    herdr(argumentsList, request.signal),
  );

  const width = agentWidth(layout, request.agentPane);

  const placement: ReviewPlacement = reviewPlacement({
    width,
    zoomed: layout.zoomed === true,
    minimumWidth: minimumPane.width,
  });

  return placement === 'right'
    ? openSplit(herdr, request, focus)
    : openTab(herdr, request, layout, focus);
};

// Closes the tab, or the pane when the user moved the terminal out of the tab. Closing a tab
// focuses a neighbor, so the agent's tab is focused again when `refocus` says so.
const closeAt = async (
  herdr: HerdrCall,
  placement: OpenedPlacement,
  location: TerminalLocation,
  refocus: () => Promise<boolean>,
): Promise<void> => {
  if (placement.kind === 'split' || location.tabId !== placement.tabId) {
    await closePane(herdr, location.paneId);

    return;
  }

  const shouldFocus = await refocus();

  await herdr(['tab', 'close', placement.tabId]).catch(ignoreMissing('tab_not_found'));

  if (shouldFocus) {
    await herdr(['tab', 'focus', placement.agentTabId]);
  }
};

const sleep = (milliseconds: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);

    signal?.addEventListener('abort', finish, { once: true });
  });

const foregroundProcessIds = async (herdr: HerdrCall, paneId: string): Promise<number[]> => {
  const output = await herdr(['pane', 'process-info', '--pane', paneId]).catch((error: unknown) => {
    ignoreMissing('pane_not_found')(error);

    return '';
  });

  if (output === '') {
    return [];
  }

  const info = requireObject(result(output).process_info);
  const processes = info.foreground_processes;

  if (!Array.isArray(processes)) {
    return [];
  }

  return processes
    .map((process) => requireObject(process).pid)
    .filter((pid): pid is number => typeof pid === 'number');
};

const anyRunning = async (
  processIds: number[],
  isProcessRunning: CloseRequest['isProcessRunning'],
): Promise<boolean> => {
  const states = await Promise.all(processIds.map(async (pid) => isProcessRunning(pid)));

  return states.includes(true);
};

// tuicr saves its session when it exits, so deleting a comment before then could be undone.
const waitForExit = async (request: CloseRequest, processIds: number[]): Promise<void> => {
  const { signal, isProcessRunning, recordDirectory } = request;

  for (let attempt = 0; attempt < exitPollLimit; attempt += 1) {
    if (signal?.aborted === true) {
      break;
    }

    // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous wait.
    if (!(await anyRunning(processIds, isProcessRunning))) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous wait.
    await sleep(exitPollMilliseconds, signal);
  }

  throw new Error(
    `tuicr did not exit, so no comment was deleted. The review record is ${recordDirectory}; call collect with it to try again.`,
  );
};

// Closes the review left by an earlier open and waits until tuicr has exited. Does nothing when
// the terminal is gone.
export const closePlacement = async (request: CloseRequest): Promise<void> => {
  const { placement } = request;
  const herdr = herdrCaller(request);

  const location = await findTerminal(placement.terminalId, (argumentsList) =>
    herdr(argumentsList),
  );

  if (location === undefined) {
    return;
  }

  const processIds = await foregroundProcessIds(herdr, location.paneId);

  const tabWasFocused = async () => {
    const listed = await herdr(['tab', 'list', '--workspace', location.workspaceId]);
    const tabs = result(listed).tabs;

    return (
      Array.isArray(tabs) &&
      tabs.some((tab) => {
        const entry = requireObject(tab);

        return entry.tab_id === location.tabId && entry.focused === true;
      })
    );
  };

  await closeAt(herdr, placement, location, tabWasFocused);
  await waitForExit(request, processIds);
};

const locateTerminal = (herdr: HerdrCall, terminalId: string, waitSignal?: AbortSignal) =>
  findTerminal(terminalId, (argumentsList) => herdr(argumentsList, waitSignal));

// Runs a herdr action at the terminal's current pane. A pane_not_found either means the user
// closed the terminal or moved it to a new pane ID, so the action is tried again there. Returns
// false when the terminal is gone.
const atTerminal = async (
  herdr: HerdrCall,
  signal: AbortSignal | undefined,
  terminalId: string,
  action: (paneId: string) => Promise<unknown>,
): Promise<boolean> => {
  let location = await locateTerminal(herdr, terminalId, signal);

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
    location = await locateTerminal(herdr, terminalId, signal);

    // A terminal still listed at the pane that was not found has no new pane to act at.
    if (location?.paneId === previous.paneId) {
      return false;
    }
  }

  return false;
};

// Closes a review surface that open made, from wherever its terminal is now. Never moves focus,
// because open did not.
export const closeOpened = async (
  request: PaneRequest,
  placement: OpenedPlacement,
): Promise<void> => {
  const herdr = herdrCaller(request);
  const remaining = await locateTerminal(herdr, placement.terminalId);

  if (remaining !== undefined) {
    await closeAt(herdr, placement, remaining, () => Promise.resolve(false));
  }
};

// Opens the terminal beside the agent, or in a new tab when the agent pane is too narrow to split,
// starts the command in it, and returns without waiting or moving focus. A surface that opened
// closes again when the command cannot start.
export const openReview = async (request: PaneRequest): Promise<OpenedPlacement> => {
  const herdr = herdrCaller(request);
  const placement = await openPlacement(herdr, request, false);

  try {
    await atTerminal(herdr, request.signal, placement.terminalId, (paneId) =>
      herdr(['pane', 'run', paneId, request.command], request.signal),
    );
  } catch (error) {
    await closeOpened(request, placement);

    throw error;
  }

  return placement;
};

// Opens the command in a pane beside the agent, or in a new tab when the agent pane is too narrow
// to split, and waits until it exits. Returns false when the signal aborted the open or the wait.
// A pane or tab that opened closes either way.
export const runInPane = async (request: PaneRequest): Promise<boolean> => {
  const { signal } = request;
  const herdr = herdrCaller(request);

  const locate = (terminalId: string) => locateTerminal(herdr, terminalId);

  let placement: OpenedPlacement;

  try {
    placement = await openPlacement(herdr, request, true);
  } catch (error) {
    if (signal?.aborted === true) {
      return false;
    }

    throw error;
  }

  const { terminalId } = placement;

  // The typed line holds the marker as a printf format and an argument, so only the finished
  // command prints the joined marker.
  const suffix = basename(request.stagingDirectory);
  const marker = `tau-draft-review-done-${suffix}`;
  const line = `${request.command}; printf 'tau-draft-review-done-%s\\n' ${quote(suffix)}`;

  try {
    const started = await atTerminal(herdr, signal, terminalId, (paneId) =>
      herdr(['pane', 'run', paneId, line], signal),
    );

    // A terminal the user closed before or during the review ends it.
    if (started) {
      await atTerminal(herdr, signal, terminalId, (paneId) =>
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
      await closeAt(herdr, placement, remaining, () => Promise.resolve(true));
    }
  }
};
