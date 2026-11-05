import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { decideDeliveryStep } from './deliveryStep.js';

type WakeContext = Pick<ExtensionContext, 'isIdle' | 'signal'>;

export interface WakeMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

export type Wake = (context: WakeContext, message: WakeMessage) => void;

export const createWake = (pi: ExtensionAPI): Wake => {
  // The extension context exposes no run state that also covers Pi's compaction after the agent
  // loop, so Tau tracks the run itself.
  let runActive = false;

  pi.on('agent_start', () => {
    runActive = true;
  });

  pi.on('agent_settled', () => {
    runActive = false;
  });

  return (context, message) => {
    const step = decideDeliveryStep({
      piIdle: context.isIdle(),
      runActive,
      agentRunning: context.signal !== undefined,
    });

    if (step === 'steer') {
      pi.sendMessage(message, { deliverAs: 'steer', triggerTurn: true });

      return;
    }

    if (step === 'wake') {
      pi.sendMessage(message, { triggerTurn: true });

      return;
    }

    pi.sendMessage(message, { deliverAs: 'nextTurn' });
  };
};
