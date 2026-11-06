import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { get, label } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import {
  createReceiptStore,
  createReceiver,
  formatInboxLabel,
  inboxLabelKey,
  startInbox,
} from '../../inbox/inbox.js';
import type { InboxListener, Receiver } from '../../inbox/inbox.js';
import type { Wake } from '../../wake/wake.js';
import type { StartupGate } from './startup.js';

export interface InboxLifecycleDependencies {
  hc: HcRuntime;
  terminal: () => string | undefined;
  socketDirectory: () => string;
  // Holds one directory of pending handover records per receiver session.
  inboxDirectory: () => string;
  gate: StartupGate;
  wake: Wake;
}

interface Generation {
  controller: AbortController;
  sessionId: string;
  drain: Promise<void>;
  receiver: Receiver | undefined;
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
    await current.receiver?.deliver(signal);
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

    const receiver = createReceiver({
      directory: join(dependencies.inboxDirectory(), current.sessionId),
      terminal,
      sessionId: current.sessionId,
      accepts: { handover: () => undefined },
      receipts: createReceiptStore(current.sessionId),
      entries: () => context.sessionManager.getEntries(),
      wake: (message) => {
        dependencies.wake(context, message);
      },
      notify: (message) => {
        notifyError(context, message);
      },
    });

    current.receiver = receiver;

    listener = await startInbox({
      sessionId: current.sessionId,
      terminal,
      directory: dependencies.socketDirectory(),
      accept: receiver.accept,
      onQueued: () => {
        requestDrain(current, context);
      },
      advertise: async (path) => {
        await label(hc, terminal, { [inboxLabelKey]: formatInboxLabel(path) });
      },
      withdraw: (path) => removeOwnLabel(hc, terminal, path),
    });
  };

  const endGeneration = (): void => {
    generation?.controller.abort();
    generation = undefined;
  };

  pi.on('session_start', async (_event, context) => {
    const endedDrain = generation?.drain ?? Promise.resolve();

    endGeneration();
    await withdraw().catch(() => undefined);

    // The first drain waits for the ended one, so two generations never deliver at once.
    const current: Generation = {
      controller: new AbortController(),
      sessionId: context.sessionManager.getSessionId(),
      drain: endedDrain,
      receiver: undefined,
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

  // A finished run may have saved receipts, so the drain can delete delivered records.
  pi.on('agent_end', (_event, context) => {
    if (generation !== undefined) {
      requestDrain(generation, context);
    }
  });

  pi.on('session_shutdown', async () => {
    endGeneration();
    await withdraw();
  });
};
