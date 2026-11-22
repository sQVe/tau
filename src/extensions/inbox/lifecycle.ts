import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { get, label } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import {
  acceptChecks,
  claimInbox,
  createReceiptStore,
  createReceiver,
  formatInboxLabel,
  inboxLabelKey,
  releaseInbox,
  startInbox,
} from '../../inbox/inbox.js';
import type { InboxListener, Receiver } from '../../inbox/inbox.js';
import { isWorkerProcess } from '../../role/role.js';
import type { Wake } from '../../wake/wake.js';
import { holdsArrival } from './arrivalDecision.js';
import type { ArrivalFacts } from './arrivalDecision.js';
import { ownsTerminal } from './ownerDecision.js';
import type { StartupGate } from './startup.js';

export interface InboxLifecycleDependencies {
  owner: symbol;
  hc: HcRuntime;
  terminal: () => string | undefined;
  socketDirectory: () => string;
  inboxDirectory: () => string;
  gate: StartupGate;
  wake: Wake;
  processGroup: () => Promise<number>;
}

interface Generation {
  controller: AbortController;
  sessionId: string;
  drain: Promise<void>;
  receiver: Receiver | undefined;
}

const signalState = (signal: AbortSignal | undefined): ArrivalFacts['signal'] => {
  if (signal === undefined) {
    return 'none';
  }

  return signal.aborted ? 'aborted' : 'live';
};

const familyChecks = () => {
  if (isWorkerProcess()) {
    return acceptChecks();
  }

  const { 'answer-request': answerRequest, 'architect-ask': architectAsk } = acceptChecks();

  return {
    ...(answerRequest === undefined ? {} : { 'answer-request': answerRequest }),
    ...(architectAsk === undefined ? {} : { 'architect-ask': architectAsk }),
  };
};

const notifyError = (context: ExtensionContext, message: string): void => {
  context.ui.notify(message, 'error');
};

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
  let listener: Promise<InboxListener> | undefined;
  let runActive = false;

  const deliverAll = async (current: Generation): Promise<void> => {
    const { signal } = current.controller;

    await gate.whenReady(signal);
    await current.receiver?.deliver(signal);
  };

  const requestDrain = (current: Generation, context: ExtensionContext): void => {
    current.drain = current.drain
      .then(() => deliverAll(current))
      .catch((error: unknown) => {
        if (!current.controller.signal.aborted) {
          notifyError(context, `Tau inbox delivery failed: ${errorMessage(error)}`);
        }
      });
  };

  // Shutdown joins a start already in flight, even after that start has bound the socket and
  // written the label, so it stops the start instead of leaving it serving a dead session.
  const withdraw = async (): Promise<void> => {
    const current = listener;

    listener = undefined;

    const started = await current?.catch(() => undefined);

    await started?.stop();
  };

  const advertise = async (current: Generation, context: ExtensionContext): Promise<void> => {
    const terminal = dependencies.terminal();

    if (terminal === undefined) {
      return;
    }

    const [snapshot, processGroup] = await Promise.all([
      get(hc, terminal),
      dependencies.processGroup(),
    ]);

    if (current.controller.signal.aborted) {
      return;
    }

    const foregroundPid = snapshot.foreground?.pid;

    if (!ownsTerminal({ foregroundPid, processGroup })) {
      return;
    }

    const receiver = createReceiver({
      directory: join(dependencies.inboxDirectory(), current.sessionId),
      terminal,
      sessionId: current.sessionId,
      accepts: { ...familyChecks(), handover: (_request, save) => save() },
      receipts: createReceiptStore(current.sessionId),
      entries: () => context.sessionManager.getEntries(),
      wake: (message, arrival) => {
        if (arrival === 'recovered') {
          pi.sendMessage(message, { triggerTurn: false });

          return true;
        }

        if (holdsArrival({ runActive, signal: signalState(context.signal) })) {
          return false;
        }

        dependencies.wake(context, message);

        return true;
      },
      notify: (message) => {
        notifyError(context, message);
      },
    });

    current.receiver = receiver;

    const started = startInbox({
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

    listener = started;
    await started;
  };

  const endGeneration = (): void => {
    generation?.controller.abort();
    generation = undefined;
  };

  pi.on('session_start', async (_event, context) => {
    if (!claimInbox(dependencies.owner)) {
      return;
    }

    const endedDrain = generation?.drain ?? Promise.resolve();

    endGeneration();
    await withdraw().catch(() => undefined);

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

  pi.on('agent_end', (_event, context) => {
    if (generation !== undefined) {
      requestDrain(generation, context);
    }
  });

  pi.on('agent_start', () => {
    runActive = true;
  });

  pi.on('agent_settled', (event, context) => {
    runActive = false;

    if (generation !== undefined) {
      generation.receiver?.releaseDropped({ aborted: event.aborted, mode: context.mode });
      requestDrain(generation, context);
    }
  });

  pi.on('session_shutdown', async () => {
    endGeneration();

    try {
      await withdraw();
    } finally {
      releaseInbox(dependencies.owner);
    }
  });
};
