import type { onTestFinished } from 'vitest';

import { createHcFake } from '../../../../tests/hcFake.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../../tests/inboxReceiverHarness.js';
import type { HandoverReceiver } from '../../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import type { AcceptCheck } from '../../../inbox/inbox.js';
import { createArchitectTool } from '../tool.js';
import { startLeadInbox } from './leadInbox.js';
import { holdLock, recordSession, setup } from './toolHarness.js';

export interface LiveArchitectOptions {
  withLeadInbox?: boolean;
  acceptArchitectAsk?: AcceptCheck;
}

export interface LiveArchitect {
  root: string;
  hc: HcFake;
  receiver: HandoverReceiver;
  tool: ReturnType<typeof createArchitectTool>;
}

export const startLiveArchitect = async (
  cleanup: typeof onTestFinished,
  options: LiveArchitectOptions = {},
): Promise<LiveArchitect> => {
  const { withLeadInbox = true, acceptArchitectAsk } = options;
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  const receiver = await startHandoverReceiver(
    cleanup,
    temporaryDirectory(cleanup, 'tau-live-ask-'),
    't-architect',
    {
      sessionId: 'session-architect',
      outsideSlot: true,
      accepts: {
        'architect-ask': acceptArchitectAsk ?? ((_request, save) => save()),
      },
    },
  );

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);

  if (withLeadInbox) {
    await startLeadInbox(cleanup, hc);
  }

  hc.replyGet(
    't-architect',
    JSON.stringify({
      address: 't-architect',
      name: null,
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${receiver.path}` },
    }),
  );

  return { root, hc, receiver, tool: createArchitectTool({ ...hc, cwd: root }) };
};
