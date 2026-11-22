import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { piExec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { holdsInbox, socketDirectoryFor } from '../../inbox/inbox.js';
import { createWake } from '../../wake/wake.js';
import { guardTerminalTyping } from './guard.js';
import { registerInboxLifecycle } from './lifecycle.js';
import { readProcessGroup } from './processGroup.js';
import { createStartupGate } from './startup.js';

export interface InboxExtensionDependencies {
  owner: symbol;
  hc: HcRuntime;
  socketDirectory: () => string;
  inboxDirectory: () => string;
  processGroup: () => Promise<number>;
}

export const createInboxExtension =
  (dependencies: InboxExtensionDependencies) =>
  (pi: ExtensionAPI): void => {
    pi.on('tool_call', (event) =>
      holdsInbox(dependencies.owner) ? guardTerminalTyping(event) : undefined,
    );

    registerInboxLifecycle(pi, {
      owner: dependencies.owner,
      hc: dependencies.hc,
      terminal: currentTerminalAddress,
      socketDirectory: dependencies.socketDirectory,
      inboxDirectory: dependencies.inboxDirectory,
      processGroup: dependencies.processGroup,
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
  createInboxExtension({
    owner: Symbol('tau inbox'),
    hc: { exec: piExec(pi), connect, cwd: process.cwd() },
    socketDirectory: currentSocketDirectory,
    inboxDirectory: () => join(getAgentDir(), 'tau', 'inbox'),
    processGroup: () => readProcessGroup(piExec(pi), process.pid),
  })(pi);
}
