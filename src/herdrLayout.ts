import { requireObject, result } from './terminal.js';
import type { TerminalCall } from './terminal.js';

export type PaneLayout = Record<string, unknown> & { panes: unknown[] };

export interface Rectangle {
  width: number;
  height: number;
}

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
