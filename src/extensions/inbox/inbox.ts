import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { socketDirectoryFor } from '../../inbox/inbox.js';
import { createWake } from '../../wake/wake.js';
import { registerInboxLifecycle } from './lifecycle.js';
import { createStartupGate } from './startup.js';

export interface InboxExtensionDependencies {
  hc: HcRuntime;
  socketDirectory: () => string;
  inboxDirectory: () => string;
}

export const createInboxExtension =
  (dependencies: InboxExtensionDependencies) =>
  (pi: ExtensionAPI): void => {
    registerInboxLifecycle(pi, {
      hc: dependencies.hc,
      terminal: currentTerminalAddress,
      socketDirectory: dependencies.socketDirectory,
      inboxDirectory: dependencies.inboxDirectory,
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

const piExec =
  (pi: ExtensionAPI): Exec =>
  (command, commandArguments, options) =>
    pi.exec(command, commandArguments, options);

export default function inboxExtension(pi: ExtensionAPI): void {
  createInboxExtension({
    hc: { exec: piExec(pi), connect, cwd: process.cwd() },
    socketDirectory: currentSocketDirectory,
    inboxDirectory: () => join(getAgentDir(), 'tau', 'inbox'),
  })(pi);
}
