import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { confirm } from './confirm.js';
import { confirmationRefusal } from './confirmationEligibility.js';
import { isWorkerProcess } from './workerProcess.js';

interface ConfirmRequest {
  // What needs the confirmation, such as "Writing to Linear".
  action: string;
  title: string;
  message: string;
}

// A worker pane has UI, but the user does not watch it, so a confirm there could approve a write
// nobody saw.
export const confirmWithUser = async (
  context: ExtensionContext,
  request: ConfirmRequest,
): Promise<boolean> => {
  const facts = { isWorker: isWorkerProcess(), hasUI: context.hasUI };
  const refusal = confirmationRefusal(facts, request.action);

  if (refusal !== undefined) {
    throw new Error(refusal);
  }

  return confirm(context, request.title, request.message);
};
