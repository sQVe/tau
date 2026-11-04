import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { currentTerminalAddress, get, label } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { shouldClearLabels, shouldLabelSession, shouldReadTerminal } from './sessionDecision.js';
import type { ReadFacts, StartFacts } from './sessionDecision.js';

export interface SessionResume {
  sessionStarted: (context: ExtensionContext) => Promise<void>;
  sessionShutdown: () => Promise<void>;
}

const readTerminal = async (hc: HcRuntime, terminalId: string) => {
  try {
    return await get(hc, terminalId);
  } catch {
    return undefined;
  }
};

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

  const noteSignal = () => {
    signalReceived = true;
  };

  const listenForSignals = () => {
    signalReceived = false;
    process.on('SIGTERM', noteSignal);

    if (process.platform !== 'win32') {
      process.on('SIGHUP', noteSignal);
    }
  };

  const stopListeningForSignals = () => {
    process.off('SIGTERM', noteSignal);
    process.off('SIGHUP', noteSignal);
  };

  const labelOwnTerminal = async (context: ExtensionContext): Promise<void> => {
    const readFacts: ReadFacts = {
      interactive: context.mode === 'tui',
      terminalId: currentTerminalAddress(),
    };

    if (!shouldReadTerminal(readFacts)) {
      return;
    }

    const terminal = await readTerminal(hc, readFacts.terminalId);

    const facts: StartFacts = {
      interactive: readFacts.interactive,
      terminalId: readFacts.terminalId,
      foregroundPid: terminal?.foreground?.pid,
      processPid: process.pid,
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

  return {
    async sessionStarted(context) {
      stopListeningForSignals();
      listenForSignals();
      ownsSession = false;

      await labelOwnTerminal(context);
    },
    async sessionShutdown() {
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
