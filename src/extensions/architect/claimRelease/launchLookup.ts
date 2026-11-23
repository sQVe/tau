import { setTimeout as sleep } from 'node:timers/promises';

import { get, ls } from '../../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../../hc/hc.js';

type LaunchLookupKind = 'ask' | 'open';

interface LaunchLookupRequest {
  kind: LaunchLookupKind;
  identifier: string;
  hc: HcRuntime;
}

type LaunchLookupResult =
  | { kind: 'found'; terminal: string }
  | { kind: 'absent' }
  | { kind: 'unread' };

const pollMilliseconds = 250;
const lookupMilliseconds = 10_000;
const claimArgument = 'TAU_ARCHITECT_CLAIM=';

const carriesClaim = (terminal: HcTerminal, claimToken: string): boolean =>
  terminal.argv?.includes(`${claimArgument}${claimToken}`) ?? false;

const findAsk = async (hc: HcRuntime, askId: string): Promise<string | undefined> => {
  const listed = await ls(hc, { all: true, labels: { 'tau.architect.ask': askId } });

  return listed.terminals.find((terminal) => terminal.address !== '')?.address;
};

const findOpen = async (hc: HcRuntime, claimToken: string): Promise<string | undefined> => {
  const listed = await ls(hc, { all: true });

  const addresses = listed.terminals
    .map((terminal) => terminal.address)
    .filter((address) => address !== '');

  const terminals = await Promise.all(addresses.map((address) => get(hc, address)));

  return terminals.find((terminal) => carriesClaim(terminal, claimToken))?.address;
};

export const launchLookup = async (request: LaunchLookupRequest): Promise<LaunchLookupResult> => {
  const hc = { ...request.hc, signal: undefined };
  const deadline = Date.now() + lookupMilliseconds;

  for (;;) {
    let terminal: string | undefined;

    try {
      const find = request.kind === 'ask' ? findAsk : findOpen;

      // oxlint-disable-next-line no-await-in-loop -- Each lookup depends on the previous one.
      terminal = await find(hc, request.identifier);
    } catch {
      return { kind: 'unread' };
    }

    if (terminal !== undefined) {
      return { kind: 'found', terminal };
    }

    if (Date.now() >= deadline) {
      return { kind: 'absent' };
    }

    // oxlint-disable-next-line no-await-in-loop -- Each lookup depends on the previous one.
    await sleep(pollMilliseconds);
  }
};
