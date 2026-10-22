/* oxlint-disable node/no-process-env -- The herdr connection comes from the active Pi process. */

export type TerminalCall = (argumentsList: string[]) => Promise<string>;

export interface TerminalLocation {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
}

export type PaneLayout = Record<string, unknown> & { panes: unknown[] };

export interface Rectangle {
  width: number;
  height: number;
}

const environmentValue = (name: string): string | undefined => {
  const value = process.env[name];

  return value === undefined || value === '' ? undefined : value;
};

export const insideHerdr = (): boolean => environmentValue('HERDR_ENV') === '1';

export const herdrPaneId = (): string | undefined => environmentValue('HERDR_PANE_ID');

export const herdrSocketPath = (): string | undefined => environmentValue('HERDR_SOCKET_PATH');

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const requireObject = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) {
    throw new Error('Malformed herdr response.');
  }

  return value;
};

export const result = (response: string): Record<string, unknown> =>
  requireObject(requireObject(JSON.parse(response)).result);

export const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value) {
    throw new Error('Missing herdr identity.');
  }

  return value;
};

export const terminalLocation = (value: unknown): TerminalLocation => {
  const pane = requireObject(value);

  return {
    paneId: text(pane.pane_id),
    terminalId: text(pane.terminal_id),
    workspaceId: text(pane.workspace_id),
    tabId: text(pane.tab_id),
  };
};

class TerminalIdentityError extends Error {
  override name = 'TerminalIdentityError';
}

export const listTerminals = async (call: TerminalCall): Promise<TerminalLocation[]> => {
  const panes = result(await call(['pane', 'list'])).panes;

  if (!Array.isArray(panes)) {
    throw new TypeError('Missing herdr pane inventory.');
  }

  const locations = panes.map(terminalLocation);

  if (
    new Set(locations.map((pane) => pane.paneId)).size !== locations.length ||
    new Set(locations.map((pane) => pane.terminalId)).size !== locations.length
  ) {
    throw new TerminalIdentityError('Ambiguous terminal ownership; no terminal action allowed.');
  }

  return locations;
};

// Pane IDs change across workspaces. Find the terminal immediately before input or cleanup. An
// absent terminal returns undefined; never fall back to the launch location.
export const findTerminal = async (
  terminalId: string,
  call: TerminalCall,
): Promise<TerminalLocation | undefined> => {
  const locations = await listTerminals(call);

  return locations.find((pane) => pane.terminalId === terminalId);
};

// Pane IDs change across workspaces. Resolve immediately before input or cleanup; never fall back to the launch location.
export const resolveTerminal = async (
  terminalId: string,
  call: TerminalCall,
): Promise<TerminalLocation> => {
  const location = await findTerminal(terminalId, call);

  if (!location) {
    throw new TerminalIdentityError(
      `Owned terminal ${terminalId} is absent; no terminal action allowed.`,
    );
  }

  return location;
};

// Leave room for pane borders and status rows around 80 columns and 20 useful rows.
export const minimumPane = { width: 82, height: 24 };

const isPositiveInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) > 0;

export const rectangle = (value: unknown): Rectangle => {
  const bounds = requireObject(value);

  if (!isPositiveInteger(bounds.width) || !isPositiveInteger(bounds.height)) {
    throw new Error('Invalid herdr pane dimensions.');
  }

  return { width: Number(bounds.width), height: Number(bounds.height) };
};

export const readLayout = async (paneId: string, call: TerminalCall): Promise<PaneLayout> => {
  const layout = requireObject(result(await call(['pane', 'layout', '--pane', paneId])).layout);

  if (typeof layout.zoomed !== 'boolean') {
    throw new TypeError('Missing herdr zoom state.');
  }

  if (!Array.isArray(layout.panes)) {
    throw new TypeError('Missing herdr layout panes.');
  }

  return { ...layout, panes: layout.panes };
};
