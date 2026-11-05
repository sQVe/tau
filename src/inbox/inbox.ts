import { randomUUID } from 'node:crypto';

import { currentTerminalAddress, get } from '../hc/hc.js';
import type { HcRuntime } from '../hc/hc.js';
import type { InboxEnvelope } from './envelope.js';
import { judgeLease } from './leaseDecision.js';
import type { LeaseVerdict } from './leaseDecision.js';
import { publishEnvelope, setMessageLabel } from './send.js';

export interface SendInboxRequest {
  hc: HcRuntime;
  target: string;
  family: 'handover';
  text: string;
  cwd: string;
  signal?: AbortSignal | undefined;
}

export interface SendInboxResult {
  status: 'queued';
  terminal: string;
  messageId: string;
}

const refuseError = (reason: string): Error =>
  new Error(`${reason} Nothing was queued. Use handover start to open a receiver instead.`);

const raiseLease = (lease: Exclude<LeaseVerdict, { kind: 'live' }>, terminal: string): never => {
  if (lease.kind === 'absent') {
    throw refuseError(`${terminal} has no inbox lease.`);
  }

  if (lease.kind === 'malformed') {
    throw refuseError(`${terminal} has a malformed inbox lease.`);
  }

  throw refuseError(`${terminal} has an expired inbox lease.`);
};

const liveSessionId = (lease: LeaseVerdict, terminal: string): string =>
  lease.kind === 'live' ? lease.sessionId : raiseLease(lease, terminal);

export const sendInboxMessage = async (request: SendInboxRequest): Promise<SendInboxResult> => {
  const { hc, target, family, text, cwd, signal } = request;
  const hcWithSignal: HcRuntime = signal === undefined ? hc : { ...hc, signal };
  const caller = currentTerminalAddress();

  if (caller === undefined) {
    throw refuseError('This session has no terminal address.');
  }

  if (target.includes('/')) {
    throw refuseError(`The target ${target} is on another machine.`);
  }

  const receiver = await get(hcWithSignal, target);

  signal?.throwIfAborted();

  if (receiver.address.includes('/')) {
    throw refuseError(`The target ${receiver.address} is on another machine.`);
  }

  if (receiver.address === caller) {
    throw refuseError("The target is this session's own terminal.");
  }

  if (receiver.state !== 'live') {
    throw refuseError(`The target ${receiver.address} is not live.`);
  }

  const lease = judgeLease(receiver.labels?.['tau.inbox'], Date.now());
  const targetSessionId = liveSessionId(lease, receiver.address);
  const messageId = randomUUID();

  const envelope: InboxEnvelope = {
    version: 1,
    messageId,
    targetTerminal: receiver.address,
    targetSessionId,
    family,
    text,
  };

  const path = await publishEnvelope(cwd, envelope);

  try {
    signal?.throwIfAborted();
  } catch (error) {
    throw new Error(
      `The envelope was written to ${path}, but the send was aborted before its inbox label was set. Nothing else was queued.`,
      { cause: error },
    );
  }

  try {
    await setMessageLabel(hcWithSignal, receiver.address, messageId, path);
  } catch (error) {
    throw new Error(
      `The envelope ${messageId} at ${path} was written, but its inbox label may or may not be set. Nothing is retried.`,
      { cause: error },
    );
  }

  return { status: 'queued', terminal: receiver.address, messageId };
};
