export type TerminalCall = (arguments_: string[]) => Promise<string>;

export interface TerminalLocation {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) {
    throw new Error('Malformed herdr response.');
  }

  return value;
};

export const result = (response: string): Record<string, unknown> =>
  object(object(JSON.parse(response)).result);

export const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value) {
    throw new Error('Missing herdr identity.');
  }

  return value;
};

export const terminalLocation = (value: unknown): TerminalLocation => {
  const pane = object(value);

  return {
    paneId: text(pane.pane_id),
    terminalId: text(pane.terminal_id),
    workspaceId: text(pane.workspace_id),
    tabId: text(pane.tab_id),
  };
};

export class TerminalIdentityError extends Error {
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

// Pane IDs change across workspaces. Resolve immediately before input or cleanup; never fall back to the launch location.
export const resolveTerminal = async (
  terminalId: string,
  call: TerminalCall,
): Promise<TerminalLocation> => {
  const locations = await listTerminals(call);
  const location = locations.find((pane) => pane.terminalId === terminalId);
  if (!location) {
    throw new TerminalIdentityError(
      `Owned terminal ${terminalId} is absent; no terminal action allowed.`,
    );
  }

  return location;
};
