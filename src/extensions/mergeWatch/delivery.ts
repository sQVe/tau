import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createWake } from '../../wake/wake.js';

type DeliveryContext = Pick<ExtensionContext, 'isIdle' | 'signal'>;

export type Deliver = (context: DeliveryContext, content: string) => void;

export const createDelivery = (pi: ExtensionAPI): Deliver => {
  const wake = createWake(pi);

  return (context, content) => {
    wake(context, { customType: 'tau-merge-watch', content, display: true });
  };
};
