import { parseJsonObject } from '../command.js';
import { errorMessage } from '../errors.js';
import { text } from '../schema.js';
import { readStartedModel } from './startedModel/startedModelReadback.js';
import type { ReadForegroundArgv } from './startedModel/startedModelReadback.js';

export interface StartedTabReadRequest {
  readForegroundArgv: ReadForegroundArgv;
  model: string | undefined;
  task: string;
}

// A launch that used its whole budget still leaves a window to read the model, so a slow launch is
// not reported as an unknown model.
const readbackMinimumMilliseconds = 5_000;

const readbackDeadline = (deadline: number): number =>
  Math.max(deadline, Date.now() + readbackMinimumMilliseconds);

export const replyText = (record: Record<string, unknown>, field: string): string | undefined => {
  const value = text(record[field]);

  return value === '' ? undefined : value;
};

const placeOf = (record: Record<string, unknown>): string => {
  const places: string[] = [];

  for (const field of ['space', 'tab', 'pane'] as const) {
    const value = replyText(record, field);

    if (value !== undefined) {
      places.push(`${field} ${value}`);
    }
  }

  return places.length === 0 ? '' : ` (${places.join(', ')})`;
};

const startedTabMessage = (
  record: Record<string, unknown> | undefined,
  terminal: string,
  error: unknown,
): string => {
  const where = record === undefined ? '' : placeOf(record);
  const reason = errorMessage(error).replace(/[.!?]$/u, '');
  const reasonPrefix = reason === '' ? '' : `${reason}. `;

  return `${reasonPrefix}The started terminal ${terminal}${where} may still be running; check it with hc get ${terminal} and stop it with hc kill ${terminal} if you do not want to keep it.`;
};

// The readback runs after the tab exists, so any failure, including the caller's cancellation, must
// still name the tab a caller can stop. The failure stays reachable as the cause.
export class StartedTabError extends Error {
  readonly terminal: string;
  readonly space: string | undefined;
  readonly tab: string | undefined;
  readonly pane: string | undefined;

  constructor(reply: string, terminal: string, error: unknown) {
    const record = parseJsonObject(reply);

    super(startedTabMessage(record, terminal, error), { cause: error });

    this.name = 'StartedTabError';
    this.terminal = terminal;
    this.space = record === undefined ? undefined : replyText(record, 'space');
    this.tab = record === undefined ? undefined : replyText(record, 'tab');
    this.pane = record === undefined ? undefined : replyText(record, 'pane');
  }
}

// A failure or an abort during the readback reaches the caller as a started-tab error, so a caller
// that only throws still learns which tab may be running. The failure stays reachable as the cause.
export const readStartedTerminalModel = async (
  request: StartedTabReadRequest,
  reply: string,
  terminal: string,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<string> => {
  try {
    return await readStartedModel({
      readForegroundArgv: request.readForegroundArgv,
      terminal,
      model: request.model,
      message: request.task,
      signal,
      deadline: readbackDeadline(deadline),
    });
  } catch (error) {
    throw new StartedTabError(reply, terminal, error);
  }
};
