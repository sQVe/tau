import { inboxLabelKey, isUuid, parseInboxLabel } from './protocol.js';

export interface TargetFacts {
  address: string;
  state: string;
  labels: Readonly<Record<string, string>>;
  ownAddress: string | undefined;
  retrySessionId: string | undefined;
}

export type TargetDecision =
  | { kind: 'connect'; path: string; sessionId: string }
  | { kind: 'refuse'; reason: string };

const isRemote = (address: string): boolean => address.includes('/');

const socketSession = (path: string): string | undefined => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const sessionId = name.slice(0, -'.sock'.length);

  return name.endsWith('.sock') && isUuid(sessionId) ? sessionId : undefined;
};

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

  const sessionId = socketSession(parsed.path);

  if (sessionId === undefined) {
    return { kind: 'refuse', reason: `Terminal ${address} advertises a socket without a session.` };
  }

  const { retrySessionId } = facts;

  if (retrySessionId !== undefined && retrySessionId !== sessionId) {
    return {
      kind: 'refuse',
      reason: `Terminal ${address} changed session from ${retrySessionId} to ${sessionId}; the original message may have arrived in session ${retrySessionId}.`,
    };
  }

  return { kind: 'connect', path: parsed.path, sessionId };
};
