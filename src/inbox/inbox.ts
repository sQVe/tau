import { randomUUID } from 'node:crypto';

import type { SubscribeEvents } from '../hc/events.js';
import { currentTerminalAddress, get } from '../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../hc/hc.js';
import type { Wake } from '../wake/wake.js';
import { envelopeVersion } from './envelope.js';
import type { InboxEnvelope } from './envelope.js';
import { judgeLease } from './leaseDecision.js';
import type { LeaseVerdict } from './leaseDecision.js';
import type { InboxFamily } from './receiptDecision.js';
import type { InboxScanContext, StartupGate } from './receive.js';
import { publishEnvelope, setMessageLabel } from './send.js';
import type { InboxSender } from './send.js';
import { createInboxWatch } from './watch.js';
import type { InboxWatch } from './watch.js';

export type { InboxEnvelope } from './envelope.js';
export type { InboxSender } from './send.js';
export { inboxMessageType, readInboxReceipt } from './receiptDecision.js';
export type { InboxReceipt, ReceiptEntryFact } from './receiptDecision.js';
export type { InboxWatch } from './watch.js';

interface InboxReceiverDependencies {
  hc: HcRuntime;
  subscribe: SubscribeEvents;
  terminal: () => string | undefined;
  gate: StartupGate;
  wake: Wake;
  notify: (context: InboxScanContext, message: string, key: string) => void;
}

export interface InboxTargetRequest {
  hc: HcRuntime;
  target: string;
  sender: InboxSender;
  signal?: AbortSignal | undefined;
}

export interface InboxTarget {
  terminal: string;
  sessionId: string;
  snapshot: HcTerminal;
}

export interface SendInboxRequest extends InboxTargetRequest {
  family: InboxFamily;
  text: string;
  cwd: string;
  expectedSessionId?: string | undefined;
}

export interface SendInboxResult {
  status: 'queued';
  terminal: string;
  messageId: string;
}

export const createInboxReceiver = (dependencies: InboxReceiverDependencies): InboxWatch =>
  createInboxWatch(dependencies);

const refuseError = (sender: InboxSender, reason: string): Error =>
  new Error(`${reason} Nothing was queued. ${sender.recovery}`);

const leaseProblem = (lease: Exclude<LeaseVerdict, { kind: 'live' }>, terminal: string): string => {
  if (lease.kind === 'absent') {
    return `${terminal} has no inbox lease.`;
  }

  if (lease.kind === 'malformed') {
    return `${terminal} has a malformed inbox lease.`;
  }

  return `${terminal} has an expired inbox lease.`;
};

export const checkInboxTarget = async (request: InboxTargetRequest): Promise<InboxTarget> => {
  const { hc, target, sender, signal } = request;
  const hcWithSignal: HcRuntime = signal === undefined ? hc : { ...hc, signal };
  const caller = currentTerminalAddress();

  if (caller === undefined) {
    throw refuseError(sender, 'This session has no terminal address.');
  }

  if (target.includes('/')) {
    throw refuseError(sender, `The target ${target} is on another machine.`);
  }

  const receiver = await get(hcWithSignal, target);

  signal?.throwIfAborted();

  if (receiver.address.includes('/')) {
    throw refuseError(sender, `The target ${receiver.address} is on another machine.`);
  }

  if (receiver.address === caller) {
    throw refuseError(sender, "The target is this session's own terminal.");
  }

  if (receiver.state !== 'live') {
    throw refuseError(sender, `The target ${receiver.address} is not live.`);
  }

  const lease = judgeLease(receiver.labels?.['tau.inbox'], Date.now());

  if (lease.kind !== 'live') {
    throw refuseError(sender, leaseProblem(lease, receiver.address));
  }

  return { terminal: receiver.address, sessionId: lease.sessionId, snapshot: receiver };
};

export const sendInboxMessage = async (request: SendInboxRequest): Promise<SendInboxResult> => {
  const { hc, target, family, sender, text, cwd, signal, expectedSessionId } = request;
  const hcWithSignal: HcRuntime = signal === undefined ? hc : { ...hc, signal };
  const receiver = await checkInboxTarget({ hc, target, sender, signal });

  const hasMovedSession =
    expectedSessionId !== undefined && receiver.sessionId !== expectedSessionId;

  if (hasMovedSession) {
    throw refuseError(
      sender,
      `${receiver.terminal} now has inbox session ${receiver.sessionId}, not ${expectedSessionId}.`,
    );
  }

  const messageId = randomUUID();

  const envelope: InboxEnvelope = {
    version: envelopeVersion,
    messageId,
    targetTerminal: receiver.terminal,
    targetSessionId: receiver.sessionId,
    family,
    text,
  };

  const path = await publishEnvelope(cwd, envelope, sender);

  try {
    signal?.throwIfAborted();
  } catch (error) {
    throw new Error(
      `The envelope was written to ${path}, but the send was aborted before its inbox label was set. Nothing else was queued.`,
      { cause: error },
    );
  }

  try {
    await setMessageLabel(hcWithSignal, receiver.terminal, messageId, path);
  } catch (error) {
    throw new Error(
      `The envelope ${messageId} at ${path} was written, but its inbox label may or may not be set. Nothing is retried.`,
      { cause: error },
    );
  }

  return { status: 'queued', terminal: receiver.terminal, messageId };
};
