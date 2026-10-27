import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { decideDeliveryStep } from './deliveryStep.js';

type DeliveryContext = Pick<ExtensionContext, 'isIdle' | 'signal'>;

export type Deliver = (context: DeliveryContext, content: string) => void;

export const createDelivery = (pi: ExtensionAPI): Deliver => {
  // The extension context exposes no run state that also covers Pi's compaction after the agent
  // loop, so Tau tracks the run itself.
  let runActive = false;

  pi.on('agent_start', () => {
    runActive = true;
  });

  pi.on('agent_settled', () => {
    runActive = false;
  });

  return (context, content) => {
    const message = { customType: 'tau-merge-watch', content, display: true };

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
