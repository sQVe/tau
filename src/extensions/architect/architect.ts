import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { piExec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import type { HcRuntime } from '../../hc/hc.js';
import { setAcceptCheck } from '../../inbox/inbox.js';
import { currentRole } from '../../role/role.js';
import { roleRegistersTool } from '../../role/roleTools.js';
import { acceptArchitectAsk } from './askAcceptance.js';
import { registerAskMode } from './askMode.js';
import { blockFinalHandover } from './openLiveAsks.js';
import { isFinalHandover } from './queuedHandover.js';
import { createHeldLockToken, endArchitectSession, startArchitectSession } from './session.js';
import type { ArchitectSession, HeldLockToken } from './session.js';
import { createArchitectAnswerTool, createArchitectTool } from './tool.js';

const registerVisibleArchitect = (
  pi: ExtensionAPI,
  hc: HcRuntime,
  current: () => ArchitectSession | undefined,
  held: HeldLockToken,
): void => {
  pi.registerTool(createArchitectAnswerTool(hc));

  setAcceptCheck('architect-ask', acceptArchitectAsk(held.current));

  pi.on('tool_call', async (event) => {
    const session = current();

    return session === undefined
      ? undefined
      : blockFinalHandover(event, { root: session.root, sessionId: session.owner.sessionId });
  });

  pi.on('tool_result', (event, context) => {
    if (isFinalHandover(event)) {
      context.shutdown();
    }
  });
};

export default function architectExtension(pi: ExtensionAPI): void {
  // oxlint-disable-next-line node/no-process-env -- The ask terminal receives its record path in its environment.
  const askRecordPath = process.env.TAU_ARCHITECT_ASK;
  const hc: HcRuntime = { exec: piExec(pi), connect, cwd: process.cwd() };
  const held = createHeldLockToken();
  let session: ArchitectSession | undefined;

  if (askRecordPath !== undefined && askRecordPath !== '') {
    registerAskMode(pi, askRecordPath);
  } else if (currentRole() === 'architect') {
    registerVisibleArchitect(pi, hc, () => session, held);
  }

  if (roleRegistersTool(currentRole(), 'architect')) {
    pi.registerTool(createArchitectTool(hc));
  }

  pi.on('session_start', async (_event, context) => {
    session = await startArchitectSession(context, held);
  });

  // Clearing the session first makes the architect-ask check refuse before the lock is released.
  pi.on('session_shutdown', async () => {
    const ending = session;

    session = undefined;

    if (ending !== undefined) {
      await endArchitectSession(ending, hc);
    }
  });
}
