import { readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../../../errors.js';
import { processState } from '../../../process/process.js';
import type { ProcessState } from '../../../process/process.js';
import { ensureTauDirectory } from '../../../tauDirectory.js';
import { sweepAction } from './startTicketDecision.js';

export type StartTicketCancel = 'cancelled' | 'taken' | 'unread';

export type StartMarker =
  | {
      kind: 'started' | 'adopted';
      token: string;
      leadPid: number;
      childPid: number;
      path: string;
    }
  | { kind: 'malformed'; token: string; path: string };

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

type StartName =
  | { kind: 'ticket'; token: string; ticket: string }
  | { kind: 'marker'; marker: StartMarker }
  | { kind: 'cancelled'; token: string }
  | { kind: 'unknown'; name: string };

const markerSuffixes = ['.started', '.adopted'] as const;
const cancelledSuffix = '.cancelled';
const leadSegment = '.lead.';
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

export const createStartTicket = async (
  root: string,
  token: string,
  leadPid: number,
): Promise<string> => {
  const directory = await startDirectory(root);
  const ticket = join(directory, `${token}${leadSegment}${leadPid}`);

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

  // A leftover cancelled name is ignored by the sweep, so a failed removal must not fail the
  // cancellation.
  await rm(cancelled, { force: true }).catch(() => undefined);

  return 'cancelled';
};

const processIdFrom = (raw: string): number | undefined => {
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    return undefined;
  }

  const processId = Number(raw);

  return Number.isSafeInteger(processId) ? processId : undefined;
};

const markerOf = (
  directory: string,
  token: string,
  leadPid: number,
  kind: 'started' | 'adopted',
  childPid: number,
  name: string,
): StartMarker => ({
  kind,
  token,
  leadPid,
  childPid,
  path: join(directory, name),
});

const markerParts = (
  directory: string,
  token: string,
  rest: string,
  name: string,
): StartMarker | undefined => {
  const [leadRaw, kind, childRaw, ...extra] = rest.split('.');
  const recognisedKind = kind === 'started' || kind === 'adopted';

  if (extra.length > 0 || !recognisedKind) {
    return undefined;
  }

  const leadPid = leadRaw === undefined ? undefined : processIdFrom(leadRaw);
  const childPid = childRaw === undefined ? undefined : processIdFrom(childRaw);

  return leadPid === undefined || childPid === undefined
    ? undefined
    : markerOf(directory, token, leadPid, kind, childPid, name);
};

// Only the four agreed names are accepted. Every other name is malformed, so a later release's
// name never lets the sweep delete or cancel it.
const parseStartName = (directory: string, name: string): StartName => {
  const leadAt = name.indexOf(leadSegment);

  if (leadAt === -1) {
    return { kind: 'unknown', name };
  }

  const token = name.slice(0, leadAt);
  const rest = name.slice(leadAt + leadSegment.length);
  const path = join(directory, name);

  if (token === '') {
    return { kind: 'marker', marker: { kind: 'malformed', token, path } };
  }

  const leadPid = processIdFrom(rest);

  if (leadPid !== undefined) {
    return { kind: 'ticket', token, ticket: join(directory, name) };
  }

  const marker = markerParts(directory, token, rest, name);

  if (marker !== undefined) {
    return { kind: 'marker', marker };
  }

  if (rest.endsWith(cancelledSuffix)) {
    const leadRaw = rest.slice(0, -cancelledSuffix.length);

    if (processIdFrom(leadRaw) !== undefined) {
      return { kind: 'cancelled', token };
    }
  }

  return { kind: 'marker', marker: { kind: 'malformed', token, path } };
};

const knownTokensOf = (names: readonly StartName[]): Set<string> => {
  const tokens = new Set<string>();

  for (const name of names) {
    if (name.kind === 'ticket') {
      tokens.add(name.token);
    }

    if (name.kind === 'marker' && name.marker.kind !== 'malformed') {
      tokens.add(name.marker.token);
    }

    if (name.kind === 'cancelled') {
      tokens.add(name.token);
    }
  }

  return tokens;
};

const knownTokenPrefix = (name: string, tokens: ReadonlySet<string>): string | undefined =>
  [...tokens]
    .filter((token) => name === token || name.startsWith(`${token}.`))
    .toSorted((left, right) => right.length - left.length)[0];

const entryOfName = (
  directory: string,
  name: StartName,
  knownTokens: ReadonlySet<string>,
): StartEntry | undefined => {
  if (name.kind === 'cancelled') {
    return undefined;
  }

  if (name.kind === 'ticket') {
    return { kind: 'unused', token: name.token, ticket: name.ticket };
  }

  if (name.kind === 'marker') {
    const { token } = name.marker;

    return { kind: 'marker', token, ticket: join(directory, token), marker: name.marker };
  }

  const token = knownTokenPrefix(name.name, knownTokens) ?? name.name;

  if (token === '') {
    return undefined;
  }

  return {
    kind: 'marker',
    token,
    ticket: join(directory, token),
    marker: { kind: 'malformed', token, path: join(directory, name.name) },
  };
};

export const readStartMarker = async (
  root: string,
  token: string,
  leadPid?: number,
): Promise<StartMarker | undefined> => {
  const directory = await startDirectory(root);
  const names = await readNames(directory);

  const markers = names
    .map((name) => parseStartName(directory, name))
    .filter((name): name is Extract<StartName, { kind: 'marker' }> => name.kind === 'marker')
    .map((name) => name.marker)
    .filter((marker) => marker.token === token)
    .filter((marker) => {
      const matchesLead = marker.kind === 'malformed' || marker.leadPid === leadPid;

      return leadPid === undefined || matchesLead;
    });

  return markers.toSorted((left, right) => left.path.localeCompare(right.path))[0];
};

// The architect keeps the started name only until it takes the claim over. A rename keeps the
// kernel-verified process id for the caller after adoption.
export const adoptStartMarker = async (
  root: string,
  token: string,
  processId: number,
): Promise<void> => {
  const directory = await startDirectory(root);
  const names = await readNames(directory);
  const prefix = `${token}${leadSegment}`;
  const suffix = `.started.${processId}`;

  const name = names.find(
    (candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix),
  );

  if (name === undefined) {
    return;
  }

  const leadRaw = name.slice(prefix.length, -suffix.length);

  if (processIdFrom(leadRaw) === undefined) {
    return;
  }

  const adopted = `${token}${leadSegment}${leadRaw}.adopted.${processId}`;

  try {
    await rename(join(directory, name), join(directory, adopted));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
};

export const deleteStartMarker = async (
  root: string,
  token: string,
  leadPid: number,
  processId: number,
): Promise<void> => {
  const directory = await startDirectory(root);

  const names = markerSuffixes.map(
    (suffix) => `${token}${leadSegment}${leadPid}${suffix}.${processId}`,
  );

  await Promise.all(names.map((name) => rm(join(directory, name), { force: true })));
};

// A malformed name for a token must be reported even when another marker for the same token
// parses, so the sweep never starts past it.
const isMalformedMarker = (entry: StartEntry): boolean =>
  entry.kind === 'marker' && entry.marker.kind === 'malformed';

const preferredEntry = (current: StartEntry | undefined, entry: StartEntry): StartEntry => {
  if (current === undefined || current.kind === 'unused') {
    return entry;
  }

  return isMalformedMarker(entry) && !isMalformedMarker(current) ? entry : current;
};

export const readStartEntries = async (root: string): Promise<StartEntry[]> => {
  const directory = await startDirectory(root);
  const names = await readNames(directory);
  const parsed = names.map((name) => parseStartName(directory, name));
  const knownTokens = knownTokensOf(parsed);
  const entries = new Map<string, StartEntry>();

  for (const name of parsed) {
    const entry = entryOfName(directory, name, knownTokens);

    if (entry === undefined) {
      continue;
    }

    entries.set(entry.token, preferredEntry(entries.get(entry.token), entry));
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

const sweepFactsOf = (
  marker: StartMarker,
  stateOf: (processId: number) => ProcessState,
): Parameters<typeof sweepAction>[0] => {
  if (marker.kind === 'malformed') {
    return { kind: 'malformed', path: marker.path };
  }

  const child = stateOf(marker.childPid);

  return marker.kind === 'started'
    ? { kind: 'started', path: marker.path, processId: marker.childPid, child }
    : {
        kind: 'adopted',
        path: marker.path,
        processId: marker.childPid,
        child,
        lead: stateOf(marker.leadPid),
      };
};

// Every other ticket belongs to a claim that is gone. A started marker is cleared only when the
// kernel reports its process gone, so a child paused before its exec keeps the fence. An adopted
// marker's child refuses a start while it runs or cannot be read. Its marker is deleted only after
// the kernel reads both its child and its lead as gone.
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

    const action = sweepAction(sweepFactsOf(resolved.marker, stateOf));

    if (action.kind === 'refuseRunning') {
      return { kind: 'refuseRunning', processId: action.processId };
    }

    if (action.kind === 'refuseMalformed') {
      return { kind: 'refuseMalformed', path: action.path };
    }

    if (action.kind === 'leave') {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- Each marker is deleted before the next check.
    await rm(action.path, { force: true });
  }

  return { kind: 'clear' };
};
