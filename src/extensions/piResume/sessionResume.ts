import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { currentTerminalAddress, label } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { waitForOwnership } from '../../hc/ownership.js';
import { readProcessGroup } from '../../hc/processGroup.js';
import { shouldClearLabels, shouldLabelSession, shouldReadTerminal } from './sessionDecision.js';
import type { ReadFacts, StartFacts } from './sessionDecision.js';

export interface SessionResume {
  sessionStarted: (context: ExtensionContext) => Promise<void>;
  sessionShutdown: () => Promise<void>;
}

const writeLabels = async (
  hc: HcRuntime,
  terminalId: string,
  labels: Record<string, string>,
): Promise<void> => {
  try {
    await label(hc, terminalId, labels);
  } catch {
    // Labelling is best effort. A failure must not stop Pi.
  }
};

export const createSessionResume = (hc: HcRuntime): SessionResume => {
  let signalReceived = false;
  let ownsSession = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;

  const noteSignal = () => {
    signalReceived = true;
  };

  const listenForSignals = () => {
    signalReceived = false;
    process.on('SIGTERM', noteSignal);
    process.on('SIGHUP', noteSignal);
  };

  const stopListeningForSignals = () => {
    process.off('SIGTERM', noteSignal);
    process.off('SIGHUP', noteSignal);
  };

  const labelOwnTerminal = async (
    current: AbortController,
    context: ExtensionContext,
  ): Promise<void> => {
    const readFacts: ReadFacts = {
      interactive: context.mode === 'tui',
      terminalId: currentTerminalAddress(),
    };

    if (!shouldReadTerminal(readFacts)) {
      return;
    }

    const processGroup = await readProcessGroup(hc.exec, process.pid);

    const ownership = await waitForOwnership(hc, {
      terminal: readFacts.terminalId,
      processGroup,
      signal: current.signal,
    });

    current.signal.throwIfAborted();

    const facts: StartFacts = {
      interactive: readFacts.interactive,
      terminalId: readFacts.terminalId,
      owner: ownership === 'owner',
      sessionFile: context.sessionManager.getSessionFile(),
      signalReceived,
    };

    if (!shouldLabelSession(facts)) {
      return;
    }

    ownsSession = true;

    await writeLabels(hc, facts.terminalId, {
      'pi.session': facts.sessionFile,
      'pi.cwd': context.cwd,
    });
  };

  const clearOwnLabels = async (): Promise<void> => {
    const terminalId = currentTerminalAddress();

    if (!ownsSession || terminalId === undefined) {
      return;
    }

    ownsSession = false;

    await writeLabels(hc, terminalId, { 'pi.session': '', 'pi.cwd': '' });
  };

  const endCurrentStart = async (): Promise<void> => {
    const ended = controller;
    const endedPending = pending;

    ended?.abort();
    controller = undefined;
    pending = undefined;

    await endedPending?.catch(() => undefined);
  };

  return {
    async sessionStarted(context) {
      stopListeningForSignals();
      listenForSignals();
      ownsSession = false;

      await endCurrentStart();

      const current = new AbortController();

      controller = current;
      pending = labelOwnTerminal(current, context).catch(() => undefined);
    },
    async sessionShutdown() {
      await endCurrentStart();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      if (shouldClearLabels({ signalReceived })) {
        await clearOwnLabels();
      }

      stopListeningForSignals();
    },
  };
};
