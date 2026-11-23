import type { onTestFinished } from 'vitest';

import type { HcFake } from '../../../../tests/hcFake.js';
import { advertiseInbox, startHandoverReceiver } from '../../../../tests/inboxReceiverHarness.js';
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
  options: Pick<HandoverReceiverOptions, 'beforeCommit'> = {},
): Promise<HandoverReceiver> => {
  const lead = await startHandoverReceiver(
    cleanup,
    temporaryDirectory(cleanup, 'tau-lead-inbox-'),
    't-lead',
    { sessionId, ...options },
  );

  advertiseInbox(hc, 't-lead', lead.path);

  return lead;
};
