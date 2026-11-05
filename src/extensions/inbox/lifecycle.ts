import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { currentTerminalAddress } from '../../hc/hc.js';
import type { InboxWatch } from '../../inbox/inbox.js';

export const registerInboxLifecycle = (pi: ExtensionAPI, watch: InboxWatch): void => {
  pi.on('session_start', async (_event, context) => {
    if (currentTerminalAddress() === undefined) {
      return;
    }

    const scanContext = {
      sessionManager: context.sessionManager,
      ui: context.ui,
      isIdle: () => context.isIdle(),
      get signal() {
        return context.signal;
      },
    };

    await watch.start({ sessionId: context.sessionManager.getSessionId(), context: scanContext });
  });

  pi.on('turn_end', () => {
    watch.requestScan();
  });

  pi.on('agent_settled', () => {
    watch.requestScan();
  });

  pi.on('session_shutdown', () => watch.stop());
};
