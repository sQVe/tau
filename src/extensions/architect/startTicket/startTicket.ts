import { readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../../../errors.js';
import { processState } from '../../../process/process.js';
import type { ProcessState } from '../../../process/process.js';
import { ensureTauDirectory } from '../../../tauDirectory.js';
import { sweepAction } from './startTicketDecision.js';

export type StartTicketCancel = 'cancelled' | 'taken' | 'unread';

export type StartMarker =
  | { kind: 'process'; pid: number; path: string }
  | { kind: 'malformed'; path: string };

export type StartEntry =
  | { kind: 'unused'; token: string; ticket: string }
  | { kind: 'marker'; token: string; ticket: string; marker: StartMarker };

export interface StartSweepRequest {
  root: string;
  currentToken: string;
  stateOf?: (processId: number) => ProcessState;
}

export type StartSweepResult =
  | { kind: 'clear' }
  | { kind: 'starting' }
  | { kind: 'refuseRunning'; processId: number }
  | { kind: 'refuseMalformed'; path: string };

type EntryResolution =
  | { kind: 'skip' }
  | { kind: 'starting' }
  | { kind: 'marker'; marker: StartMarker };

const startedSuffix = '.started';
const cancelledSuffix = '.cancelled';
const wrapperScript = 'mv -- "$1" "$1.started.$$" 2>/dev/null || exit 75; shift; exec "$@"';
const wrapperName = 'tau-architect-start';

const startDirectory = (root: string): Promise<string> =>
  ensureTauDirectory(root, 'architect/start');

export const startHeldByProcessReason = (processId: number): string =>
  `The architect in this checkout is starting under process ${processId}. Wait for that process to end or stop it, then try again.`;

export const malformedStartMarkerReason = (path: string): string =>
  `The architect start marker ${path} does not name a process. Remove that file, then try again.`;

const readNames = async (directory: string): Promise<string[]> =>
  readdir(directory).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  });

export const createStartTicket = async (root: string, token: string): Promise<string> => {
  const directory = await startDirectory(root);
  const ticket = join(directory, token);

  await writeFile(ticket, '', { flag: 'wx' });

  return ticket;
};

// The shell renames the ticket before it execs Pi, so the marker names the only process that can
// open the session file for this launch.
export const wrapStartArgv = (ticket: string, argv: string[]): string[] => [
  'sh',
  '-c',
  wrapperScript,
  wrapperName,
  ticket,
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

const markerName = (token: string): string => `${token}${startedSuffix}`;

const parseMarkerName = (
  directory: string,
  token: string,
  name: string,
): StartMarker | undefined => {
  const prefix = markerName(token);

  if (name !== prefix && !name.startsWith(`${prefix}.`)) {
    return undefined;
  }

  const path = join(directory, name);

  if (name === prefix) {
    return { kind: 'malformed', path };
  }

  const raw = name.slice(prefix.length + 1);

  if (!/^[1-9][0-9]*$/u.test(raw)) {
    return { kind: 'malformed', path };
  }

  const pid = Number(raw);

  return Number.isSafeInteger(pid) ? { kind: 'process', pid, path } : { kind: 'malformed', path };
};

export const readStartMarker = async (
  root: string,
  token: string,
): Promise<StartMarker | undefined> => {
  const directory = await startDirectory(root);
  const names = await readNames(directory);

  const markers = names
    .map((name) => parseMarkerName(directory, token, name))
    .filter((marker): marker is StartMarker => marker !== undefined);

  return markers.toSorted((left, right) => left.path.localeCompare(right.path))[0];
};

export const deleteStartMarker = async (
  root: string,
  token: string,
  processId: number,
): Promise<void> => {
  const directory = await startDirectory(root);

  await rm(join(directory, `${markerName(token)}.${processId}`), { force: true });
};

const entryOf = (directory: string, name: string): StartEntry | undefined => {
  if (name.endsWith(cancelledSuffix)) {
    const cancelledToken = name.slice(0, -cancelledSuffix.length);

    if (cancelledToken !== '' && !cancelledToken.includes(startedSuffix)) {
      return undefined;
    }
  }

  const startedAt = name.indexOf(startedSuffix);
  const started = startedAt !== -1;
  const token = started ? name.slice(0, startedAt) : name;

  const ticket = join(directory, token);

  if (!started) {
    return token === '' ? undefined : { kind: 'unused', token, ticket };
  }

  const path = join(directory, name);

  const marker =
    token === ''
      ? { kind: 'malformed' as const, path }
      : (parseMarkerName(directory, token, name) ?? { kind: 'malformed' as const, path });

  return { kind: 'marker', token, ticket, marker };
};

export const readStartEntries = async (root: string): Promise<StartEntry[]> => {
  const directory = await startDirectory(root);
  const names = await readNames(directory);
  const entries = new Map<string, StartEntry>();

  for (const name of names) {
    const entry = entryOf(directory, name);

    if (entry === undefined) {
      continue;
    }

    const current = entries.get(entry.token);

    if (current === undefined || current.kind === 'unused') {
      entries.set(entry.token, entry);
    }
  }

  return [...entries.values()];
};

const resolveEntry = async (root: string, entry: StartEntry): Promise<EntryResolution> => {
  if (entry.kind === 'marker') {
    return { kind: 'marker', marker: entry.marker };
  }

  const cancelled = await cancelStartTicket(entry.ticket);

  if (cancelled === 'cancelled') {
    return { kind: 'skip' };
  }

  if (cancelled === 'unread') {
    return { kind: 'starting' };
  }

  const marker = await readStartMarker(root, entry.token);

  return marker === undefined ? { kind: 'starting' } : { kind: 'marker', marker };
};

// Every other ticket belongs to a claim that is gone. A started marker is cleared only when the
// kernel reports its process gone, so a child paused before its exec keeps the fence.
export const sweepStartFolder = async (request: StartSweepRequest): Promise<StartSweepResult> => {
  const stateOf = request.stateOf ?? processState;
  const entries = await readStartEntries(request.root);

  for (const entry of entries) {
    if (entry.token === request.currentToken) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- Each ticket changes the folder for the next.
    const resolved = await resolveEntry(request.root, entry);

    if (resolved.kind === 'skip') {
      continue;
    }

    if (resolved.kind === 'starting') {
      return { kind: 'starting' };
    }

    const { marker } = resolved;

    const facts =
      marker.kind === 'malformed'
        ? { kind: 'malformed' as const, path: marker.path }
        : {
            kind: 'started' as const,
            path: marker.path,
            processId: marker.pid,
            child: stateOf(marker.pid),
          };

    const action = sweepAction(facts);

    if (action.kind === 'refuseRunning') {
      return { kind: 'refuseRunning', processId: action.processId };
    }

    if (action.kind === 'refuseMalformed') {
      return { kind: 'refuseMalformed', path: action.path };
    }

    if (action.kind === 'deleteMarker') {
      // oxlint-disable-next-line no-await-in-loop -- Each marker is deleted before the next check.
      await rm(action.path, { force: true });
    }
  }

  return { kind: 'clear' };
};
