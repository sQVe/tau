import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { notifyOnce } from '../../config/config.js';
import { connect } from '../../hc/connect.js';
import type { Connect } from '../../hc/connect.js';
import { subscribeEvents } from '../../hc/events.js';
import type { SubscribeEvents } from '../../hc/events.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import { createInboxReceiver } from '../../inbox/inbox.js';
import { createWake } from '../../wake/wake.js';
import type { Wake } from '../../wake/wake.js';
import { registerInboxLifecycle } from './lifecycle.js';
import { createStartupGate } from './startup.js';

export interface InboxExtensionDependencies {
  exec: Exec;
  connect: Connect;
  subscribe: SubscribeEvents;
  cwd: string;
  createWake?: ((pi: ExtensionAPI) => Wake) | undefined;
}

export const createInboxExtension =
  (dependencies: InboxExtensionDependencies) =>
  (pi: ExtensionAPI): void => {
    const gate = createStartupGate(pi);
    const createMessageWake = dependencies.createWake ?? createWake;

    const watch = createInboxReceiver({
      hc: { exec: dependencies.exec, connect: dependencies.connect, cwd: dependencies.cwd },
      subscribe: dependencies.subscribe,
      terminal: currentTerminalAddress,
      gate,
      wake: createMessageWake(pi),
      notify: (context, message, key) => {
        notifyOnce(context.ui, 'inbox', key, message, 'error');
      },
    });

    registerInboxLifecycle(pi, watch);
  };

export default function inboxExtension(pi: ExtensionAPI): void {
  createInboxExtension({
    exec: (command, commandArguments, options) => pi.exec(command, commandArguments, options),
    connect,
    subscribe: subscribeEvents,
    cwd: process.cwd(),
  })(pi);
}
