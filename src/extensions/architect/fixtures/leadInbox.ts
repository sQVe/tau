import type { onTestFinished } from 'vitest';

import type { HcFake } from '../../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../../tests/inboxReceiverHarness.js';
import type {
  HandoverReceiver,
  HandoverReceiverOptions,
} from '../../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';

// The lead's inbox owns the process inbox slot, which `currentInboxPath` reads. The ask preflight
// needs that listener and a matching terminal label.
export const startLeadInbox = async (
  cleanup: typeof onTestFinished,
  hc: HcFake,
  sessionId = 'session-lead',
  options: Pick<HandoverReceiverOptions, 'beforeCommit' | 'beforePublish'> = {},
): Promise<HandoverReceiver> => {
  const lead = await startHandoverReceiver(
    cleanup,
    temporaryDirectory(cleanup, 'tau-lead-inbox-'),
    't-lead',
    { sessionId, ...options },
  );

  hc.replyGet(
    't-lead',
    JSON.stringify({
      address: 't-lead',
      name: null,
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${lead.path}` },
    }),
  );

  return lead;
};
