import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { piExec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { claimRegistration, releaseRegistration, socketDirectoryFor } from '../../inbox/inbox.js';
import { createWake } from '../../wake/wake.js';
import { guardTerminalTyping } from './guard.js';
import { registerInboxLifecycle } from './lifecycle.js';
import { createStartupGate } from './startup.js';

export interface InboxExtensionDependencies {
  hc: HcRuntime;
  socketDirectory: () => string;
  inboxDirectory: () => string;
  processPid: number;
}

export const createInboxExtension =
  (dependencies: InboxExtensionDependencies) =>
  (pi: ExtensionAPI): void => {
    pi.on('tool_call', guardTerminalTyping);

    registerInboxLifecycle(pi, {
      hc: dependencies.hc,
      terminal: currentTerminalAddress,
      socketDirectory: dependencies.socketDirectory,
      inboxDirectory: dependencies.inboxDirectory,
      processPid: dependencies.processPid,
      gate: createStartupGate(pi),
      wake: createWake(pi),
    });
  };

const currentSocketDirectory = (): string => {
  const uid = process.getuid?.();

  if (uid === undefined) {
    throw new Error('The Tau inbox needs a POSIX user ID.');
  }

  return socketDirectoryFor(uid);
};

export default function inboxExtension(pi: ExtensionAPI): void {
  if (!claimRegistration()) {
    return;
  }

  pi.on('session_shutdown', releaseRegistration);

  createInboxExtension({
    hc: { exec: piExec(pi), connect, cwd: process.cwd() },
    socketDirectory: currentSocketDirectory,
    inboxDirectory: () => join(getAgentDir(), 'tau', 'inbox'),
    processPid: process.pid,
  })(pi);
}
