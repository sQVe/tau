import { readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../../../errors.js';
import { ensureTauDirectory } from '../../../tauDirectory.js';
import { sweepAction } from './startTicketDecision.js';
import type { StartTicketMarker, StartTicketTerminal } from './startTicketDecision.js';

export type StartTicketCancel = 'cancelled' | 'taken' | 'unread';

export interface StartEntry {
  token: string;
  ticket: string;
  marker: StartTicketMarker;
  markerPath: string;
}

export interface StartSweepRequest {
  root: string;
  currentToken: string;
  terminalOf: (token: string) => Promise<StartTicketTerminal>;
}

const startedSuffix = '.started';
const cancelledSuffix = '.cancelled';
const wrapperScript = 'mv -- "$1" "$2" 2>/dev/null || exit 75; shift 2; exec "$@"';
const wrapperName = 'tau-architect-start';

const startDirectory = (root: string): Promise<string> =>
  ensureTauDirectory(root, 'architect/start');

export const createStartTicket = async (root: string, token: string): Promise<string> => {
  const directory = await startDirectory(root);
  const ticket = join(directory, token);

  await writeFile(ticket, '', { flag: 'wx' });

  return ticket;
};

// The shell renames the ticket before it execs Pi, so Pi is still the terminal's process.
export const wrapStartArgv = (ticket: string, argv: string[]): string[] => [
  'sh',
  '-c',
  wrapperScript,
  wrapperName,
  ticket,
  `${ticket}${startedSuffix}`,
  ...argv,
];

export const cancelStartTicket = async (ticket: string): Promise<StartTicketCancel> => {
  const cancelled = `${ticket}${cancelledSuffix}`;

  try {
    await rename(ticket, cancelled);
  } catch (error) {
    return isMissingFile(error) ? 'taken' : 'unread';
  }

  await rm(cancelled, { force: true });

  return 'cancelled';
};

const removeStartMarker = (markerPath: string): Promise<void> => rm(markerPath, { force: true });

export const deleteStartMarker = async (root: string, token: string): Promise<void> => {
  const directory = await startDirectory(root);

  await removeStartMarker(join(directory, `${token}${startedSuffix}`));
};

const entryOf = (directory: string, name: string): StartEntry | undefined => {
  if (name.endsWith(cancelledSuffix)) {
    return undefined;
  }

  const started = name.endsWith(startedSuffix);
  const token = started ? name.slice(0, -startedSuffix.length) : name;

  if (token === '') {
    return undefined;
  }

  return {
    token,
    ticket: join(directory, token),
    marker: started ? 'started' : 'unused',
    markerPath: join(directory, `${token}${startedSuffix}`),
  };
};

export const readStartEntries = async (root: string): Promise<StartEntry[]> => {
  const directory = await startDirectory(root);

  const names = await readdir(directory).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  });

  const entries = names.map((name) => entryOf(directory, name));

  return entries.filter((entry): entry is StartEntry => entry !== undefined);
};

// Every other ticket belongs to a claim that is gone. A started marker refuses until its terminal
// is seen to end, because the child may have started Pi without a terminal yet.
export const sweepStartFolder = async (
  request: StartSweepRequest,
): Promise<'clear' | 'starting'> => {
  const entries = await readStartEntries(request.root);

  for (const entry of entries) {
    if (entry.token === request.currentToken) {
      continue;
    }

    let marker = entry.marker;

    if (marker === 'unused') {
      // oxlint-disable-next-line no-await-in-loop -- Each ticket changes the folder for the next.
      const cancelled = await cancelStartTicket(entry.ticket);

      if (cancelled === 'cancelled') {
        continue;
      }

      if (cancelled === 'unread') {
        return 'starting';
      }

      marker = 'started';
    }

    // oxlint-disable-next-line no-await-in-loop -- Each lookup decides whether to stop the sweep.
    const terminal = await request.terminalOf(entry.token);
    const action = sweepAction({ marker, terminal });

    if (action === 'refuse') {
      return 'starting';
    }

    if (action === 'deleteMarker') {
      // oxlint-disable-next-line no-await-in-loop -- Each marker is deleted before the next lookup.
      await removeStartMarker(entry.markerPath);
    }
  }

  return 'clear';
};
