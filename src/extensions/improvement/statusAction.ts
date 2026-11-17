import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { ImprovementStatus } from '../../improvement/statusDecision.js';
import { statusText } from '../../improvement/statusDecision.js';

const statusKey = 'improvement';

const unreadableText = 'improve: status unreadable';

const readStatusText = async (
  read: (cwd: string) => Promise<ImprovementStatus>,
  cwd: string,
): Promise<string | undefined> => {
  try {
    return statusText(await read(cwd));
  } catch {
    return unreadableText;
  }
};

export const createStatusRefresh = (
  read: (cwd: string) => Promise<ImprovementStatus>,
): ((context: ExtensionContext) => Promise<void>) => {
  let latestCall = 0;

  return async (context) => {
    latestCall += 1;
    const call = latestCall;

    try {
      if (!context.hasUI) {
        return;
      }

      const text = await readStatusText(read, context.cwd);

      if (call !== latestCall) {
        return;
      }

      context.ui.setStatus(statusKey, text);
    } catch {
      // A replaced session's context getters throw. The refresh drops the result.
    }
  };
};
