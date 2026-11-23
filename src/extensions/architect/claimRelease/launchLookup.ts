import { setTimeout as sleep } from 'node:timers/promises';

import { get, ls } from '../../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../../hc/hc.js';

type LaunchLookupKind = 'ask' | 'open';

export interface LaunchLookupRequest {
  kind: LaunchLookupKind;
  identifier: string;
  hc: HcRuntime;
}

export type LaunchLookupResult =
  | { kind: 'found'; terminal: string; state: string }
  | { kind: 'absent' }
  | { kind: 'unread' };

const pollMilliseconds = 250;
const lookupMilliseconds = 10_000;
const claimArgument = 'TAU_ARCHITECT_CLAIM=';

const carriesClaim = (terminal: HcTerminal, claimToken: string): boolean =>
  terminal.argv?.includes(`${claimArgument}${claimToken}`) ?? false;

const remaining = (deadline: number): number => Math.max(1, deadline - Date.now());

const addressesOf = (terminals: readonly HcTerminal[]): string[] =>
  terminals.map((terminal) => terminal.address).filter((address) => address !== '');

const findAsk = async (
  hc: HcRuntime,
  askId: string,
  deadline: number,
): Promise<LaunchLookupResult> => {
  const listed = await ls(hc, {
    all: true,
    labels: { 'tau.architect.ask': askId },
    timeout: remaining(deadline),
  });

  const terminal = listed.terminals.find((entry) => entry.address !== '');

  return terminal === undefined
    ? { kind: 'absent' }
    : { kind: 'found', terminal: terminal.address, state: terminal.state };
};

const findOpen = async (
  hc: HcRuntime,
  claimToken: string,
  deadline: number,
): Promise<LaunchLookupResult> => {
  const listed = await ls(hc, { all: true, timeout: remaining(deadline) });
  const addresses = addressesOf(listed.terminals);

  const reads = await Promise.allSettled(
    addresses.map((address) => get(hc, address, { timeout: remaining(deadline) })),
  );

  let unread = false;

  for (const read of reads) {
    if (read.status === 'rejected') {
      unread = true;

      continue;
    }

    const terminal = read.value;

    if (terminal.argv === undefined) {
      unread = true;

      continue;
    }

    if (carriesClaim(terminal, claimToken)) {
      return { kind: 'found', terminal: terminal.address, state: terminal.state };
    }
  }

  return unread ? { kind: 'unread' } : { kind: 'absent' };
};

// One read, so a sweep never waits for a terminal to appear.
const lookupWithin = async (
  request: LaunchLookupRequest,
  deadline: number,
): Promise<LaunchLookupResult> => {
  const hc = { ...request.hc, signal: undefined };

  try {
    return request.kind === 'ask'
      ? await findAsk(hc, request.identifier, deadline)
      : await findOpen(hc, request.identifier, deadline);
  } catch {
    return { kind: 'unread' };
  }
};

export const lookupLaunchTerminal = (request: LaunchLookupRequest): Promise<LaunchLookupResult> =>
  lookupWithin(request, Date.now() + lookupMilliseconds);

export const launchLookup = async (request: LaunchLookupRequest): Promise<LaunchLookupResult> => {
  const deadline = Date.now() + lookupMilliseconds;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Each lookup depends on the previous one.
    const result = await lookupWithin(request, deadline);

    if (result.kind !== 'absent' || Date.now() >= deadline) {
      return result;
    }

    // oxlint-disable-next-line no-await-in-loop -- Each lookup depends on the previous one.
    await sleep(pollMilliseconds);
  }
};
