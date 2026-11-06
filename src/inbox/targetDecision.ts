import { inboxLabelKey, parseInboxLabel } from './protocol.js';
import type { Family, ReadyReply } from './protocol.js';

export interface TargetFacts {
  // The address `hc get` returned, after alias resolution.
  address: string;
  state: string;
  labels: Readonly<Record<string, string>>;
  ownAddress: string | undefined;
}

export type TargetDecision = { kind: 'connect'; path: string } | { kind: 'refuse'; reason: string };

export interface ReadyExpectation {
  address: string;
  sessionId: string | undefined;
  family: Family;
}

export type ReadyDecision = { kind: 'send' } | { kind: 'refuse'; reason: string };

// A machine-qualified address such as `machine/t7` names a terminal on another host.
const isRemote = (address: string): boolean => address.includes('/');

export const decideTarget = (facts: TargetFacts): TargetDecision => {
  const { address } = facts;

  if (isRemote(address)) {
    return { kind: 'refuse', reason: `Terminal ${address} is on another machine.` };
  }

  if (address === facts.ownAddress) {
    return { kind: 'refuse', reason: `Terminal ${address} is this session's own terminal.` };
  }

  if (facts.state !== 'live') {
    return { kind: 'refuse', reason: `Terminal ${address} is ${facts.state}, not live.` };
  }

  const label = facts.labels[inboxLabelKey];

  if (label === undefined) {
    return { kind: 'refuse', reason: `Terminal ${address} advertises no Tau inbox.` };
  }

  const parsed = parseInboxLabel(label);

  if (parsed.kind === 'unsupported') {
    return {
      kind: 'refuse',
      reason: `Terminal ${address} advertises inbox protocol "${parsed.protocol}", not rpc1.`,
    };
  }

  return { kind: 'connect', path: parsed.path };
};

export const decideReady = (ready: ReadyReply, expected: ReadyExpectation): ReadyDecision => {
  if (ready.terminal !== expected.address) {
    return {
      kind: 'refuse',
      reason: `The inbox of ${expected.address} answers for terminal ${ready.terminal}.`,
    };
  }

  const sessionMatches = expected.sessionId === undefined || ready.sessionId === expected.sessionId;

  if (!sessionMatches) {
    return {
      kind: 'refuse',
      reason: `The inbox of ${expected.address} belongs to session ${ready.sessionId}, not ${String(expected.sessionId)}.`,
    };
  }

  if (!ready.families.includes(expected.family)) {
    return {
      kind: 'refuse',
      reason: `The inbox of ${expected.address} does not accept ${expected.family} messages.`,
    };
  }

  return { kind: 'send' };
};
