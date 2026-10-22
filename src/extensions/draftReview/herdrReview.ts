import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { runCommand } from '../../command.js';
import type { Exec } from '../../command.js';
import { errorMessage } from '../../errors.js';
import {
  findTerminal,
  minimumPane,
  readLayout,
  rectangle,
  requireObject,
  result,
  terminalLocation,
  text,
} from '../../herdr.js';
import type { PaneLayout, TerminalLocation } from '../../herdr.js';
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
  // The tuicr process IDs an earlier close saved, for when the terminal is already gone.
  savedProcessIds: number[] | undefined;
  // Saves the tuicr process IDs before the terminal closes.
  saveProcessIds: (processIds: number[]) => Promise<void>;
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

const closePane = async (herdr: HerdrCall, paneId: string): Promise<void> => {
  await herdr(['pane', 'close', paneId]);
};

const splitArguments = (request: PaneRequest): string[] => [
  'pane',
  'split',
  '--pane',
  request.agentPane,
  '--direction',
  'right',
  '--cwd',
  request.stagingDirectory,
];

const tabArguments = (request: PaneRequest, layout: PaneLayout): string[] => [
  'tab',
  'create',
  '--workspace',
  text(layout.workspace_id),
  '--cwd',
  request.stagingDirectory,
  '--label',
  'Draft review',
];

const openSplit = async (herdr: HerdrCall, request: PaneRequest): Promise<OpenedPlacement> => {
  const split = await herdr(splitArguments(request), request.signal);
  const { terminalId } = terminalLocation(result(split).pane);

  return { kind: 'split', terminalId };
};

const openTab = async (
  herdr: HerdrCall,
  request: PaneRequest,
  layout: PaneLayout,
): Promise<OpenedPlacement> => {
  const created = await herdr(tabArguments(request, layout), request.signal);
  const response = result(created);
  const tabId = text(requireObject(response.tab).tab_id);
  const terminalId = text(requireObject(response.root_pane).terminal_id);

  return { kind: 'tab', terminalId, tabId, agentTabId: text(layout.tab_id) };
};

const openPlacement = async (herdr: HerdrCall, request: PaneRequest): Promise<OpenedPlacement> => {
  const layout = await readLayout(request.agentPane, (argumentsList) =>
    herdr(argumentsList, request.signal),
  );

  const width = agentWidth(layout, request.agentPane);

  const placement: ReviewPlacement = reviewPlacement({
    width,
    zoomed: layout.zoomed === true,
    minimumWidth: minimumPane.width,
  });

  return placement === 'right' ? openSplit(herdr, request) : openTab(herdr, request, layout);
};

// Closes the tab, or the pane when the user moved the terminal out of the tab. Closing a tab
// focuses a neighbor, so the agent's tab is focused again when `refocus` says so.
const closeAt = async (
  herdr: HerdrCall,
  placement: OpenedPlacement,
  location: TerminalLocation,
  refocus: () => boolean | Promise<boolean>,
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

    signal?.addEventListener('abort', finish);
  });

const malformed = (what: string, output: string, recordDirectory: string): Error =>
  new Error(
    `herdr returned ${what} that tau cannot read, so tuicr was not closed and no comment was deleted: ${output}. The review record is ${recordDirectory}; call collect with it to try again.`,
  );

const processInfoSchema = Type.Object({
  result: Type.Object({
    process_info: Type.Object({
      foreground_processes: Type.Array(Type.Object({ pid: Type.Number() })),
    }),
  }),
});

const tabListSchema = Type.Object({
  result: Type.Object({
    tabs: Type.Array(Type.Object({ tab_id: Type.String(), focused: Type.Boolean() })),
  }),
});

const parseJson = (output: string, what: string, recordDirectory: string): unknown => {
  try {
    return JSON.parse(output);
  } catch {
    throw malformed(what, JSON.stringify(output), recordDirectory);
  }
};

const parseProcessIds = (output: string, recordDirectory: string): number[] => {
  const value = parseJson(output, 'process info', recordDirectory);

  if (!Value.Check(processInfoSchema, value)) {
    throw malformed('process info', JSON.stringify(output), recordDirectory);
  }

  return value.result.process_info.foreground_processes.map(({ pid }) => pid);
};

const parseFocused = (output: string, tabId: string, recordDirectory: string): boolean => {
  const value = parseJson(output, 'a tab list', recordDirectory);

  if (!Value.Check(tabListSchema, value)) {
    throw malformed('a tab list', JSON.stringify(output), recordDirectory);
  }

  return value.result.tabs.some((tab) => tab.tab_id === tabId && tab.focused);
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

const locateTerminal = (herdr: HerdrCall, terminalId: string, waitSignal?: AbortSignal) =>
  findTerminal(terminalId, (argumentsList) => herdr(argumentsList, waitSignal));

// Runs a herdr action at the terminal's current pane. A pane_not_found either means the user
// closed the terminal or moved it to a new pane ID, so the action is tried again there. Returns
// undefined when the terminal is gone.
const atTerminal = async <Outcome>(
  herdr: HerdrCall,
  signal: AbortSignal | undefined,
  terminalId: string,
  action: (location: TerminalLocation) => Promise<Outcome>,
): Promise<{ value: Outcome } | undefined> => {
  let location = await locateTerminal(herdr, terminalId, signal);

  while (location !== undefined) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each try follows the terminal to its new pane.
      const value = await action(location);

      return { value };
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
      return undefined;
    }
  }

  return undefined;
};

// Closes the review left by an earlier open and waits until tuicr has exited. Does nothing when
// the terminal is gone and no earlier close saved tuicr's process IDs.
export const closePlacement = async (request: CloseRequest): Promise<void> => {
  const { placement, recordDirectory, signal } = request;
  const herdr = herdrCaller(request);

  const found = await atTerminal(herdr, signal, placement.terminalId, async (location) => {
    const output = await herdr(['pane', 'process-info', '--pane', location.paneId]);

    return parseProcessIds(output, recordDirectory);
  });

  if (found === undefined) {
    if (request.savedProcessIds !== undefined) {
      await waitForExit(request, request.savedProcessIds);
    }

    return;
  }

  const processIds = found.value;

  await request.saveProcessIds(processIds);

  await atTerminal(herdr, signal, placement.terminalId, async (location) => {
    const tabWasFocused = async () => {
      const listed = await herdr(['tab', 'list', '--workspace', location.workspaceId]);

      return parseFocused(listed, location.tabId, recordDirectory);
    };

    await closeAt(herdr, placement, location, tabWasFocused);
  });

  await waitForExit(request, processIds);
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
    await closeAt(herdr, placement, remaining, () => false).catch(ignoreMissing('pane_not_found'));
  }
};

// Opens the terminal beside the agent, or in a new tab when the agent pane is too narrow to split,
// starts the command in it, and returns without waiting or moving focus. A surface that opened
// closes again when the command cannot start.
export const openReview = async (request: PaneRequest): Promise<OpenedPlacement> => {
  const herdr = herdrCaller(request);
  const placement = await openPlacement(herdr, request);

  try {
    await atTerminal(herdr, request.signal, placement.terminalId, ({ paneId }) =>
      herdr(['pane', 'run', paneId, request.command], request.signal),
    );
  } catch (error) {
    await closeOpened(request, placement);

    throw error;
  }

  return placement;
};
