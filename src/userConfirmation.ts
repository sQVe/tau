import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { confirm } from './confirm.js';
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
  if (isWorkerProcess()) {
    throw new Error(
      `${request.action} needs the user's confirmation, which a worker cannot give. Nothing was written. Ask the parent session to make this write.`,
    );
  }

  if (!context.hasUI) {
    throw new Error(
      `${request.action} needs the user's confirmation, which a session without UI cannot give. Nothing was written. Use a session with UI.`,
    );
  }

  return confirm(context, request.title, request.message);
};
