import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { get, label } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { familyHandlers, formatInboxLabel, inboxLabelKey, startInbox } from '../../inbox/inbox.js';
import type { InboxListener } from '../../inbox/inbox.js';
import type { StartupGate } from './startup.js';

export interface InboxLifecycleDependencies {
  hc: HcRuntime;
  terminal: () => string | undefined;
  socketDirectory: () => string;
  gate: StartupGate;
}

interface Generation {
  controller: AbortController;
  sessionId: string;
  drain: Promise<void>;
}

const notifyError = (context: ExtensionContext, message: string): void => {
  context.ui.notify(message, 'error');
};

// Removes the label only while it still names this listener's socket.
const removeOwnLabel = async (hc: HcRuntime, address: string, path: string): Promise<void> => {
  const terminal = await get(hc, address);

  if (terminal.labels?.[inboxLabelKey] !== formatInboxLabel(path)) {
    return;
  }

  await label(hc, address, { [inboxLabelKey]: '' });
};

export const registerInboxLifecycle = (
  pi: ExtensionAPI,
  dependencies: InboxLifecycleDependencies,
): void => {
  const { hc, gate } = dependencies;
  let generation: Generation | undefined;
  let listener: InboxListener | undefined;

  const deliverAll = async (current: Generation): Promise<void> => {
    const { signal } = current.controller;

    await gate.whenReady(signal);

    for (const handler of familyHandlers(current.sessionId)) {
      if (signal.aborted) {
        return;
      }

      // oxlint-disable-next-line no-await-in-loop -- Deliveries run one at a time.
      await handler.deliver(signal);
    }
  };

  // Drains run one at a time, and each drain belongs to the generation that requested it.
  const requestDrain = (current: Generation, context: ExtensionContext): void => {
    current.drain = current.drain
      .then(() => deliverAll(current))
      .catch((error: unknown) => {
        if (!current.controller.signal.aborted) {
          notifyError(context, `Tau inbox delivery failed: ${errorMessage(error)}`);
        }
      });
  };

  const withdraw = async (): Promise<void> => {
    const current = listener;

    listener = undefined;
    await current?.stop();
  };

  const advertise = async (current: Generation, context: ExtensionContext): Promise<void> => {
    const terminal = dependencies.terminal();

    if (terminal === undefined) {
      return;
    }

    listener = await startInbox({
      sessionId: current.sessionId,
      terminal,
      directory: dependencies.socketDirectory(),
      onQueued: () => {
        requestDrain(current, context);
      },
      advertise: async (path) => {
        await label(hc, terminal, { [inboxLabelKey]: formatInboxLabel(path) });
      },
      withdraw: (path) => removeOwnLabel(hc, terminal, path),
    });
  };

  pi.on('session_start', async (_event, context) => {
    generation?.controller.abort();
    await withdraw().catch(() => undefined);

    const current: Generation = {
      controller: new AbortController(),
      sessionId: context.sessionManager.getSessionId(),
      drain: Promise.resolve(),
    };

    generation = current;

    try {
      await advertise(current, context);
    } catch (error) {
      notifyError(context, `Tau inbox could not start: ${errorMessage(error)}`);

      return;
    }

    requestDrain(current, context);
  });

  pi.on('session_shutdown', async () => {
    generation?.controller.abort();
    generation = undefined;
    await withdraw();
  });
};
