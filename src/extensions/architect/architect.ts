import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { piExec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import { currentRole } from '../../role/role.js';
import { roleRegistersTool } from '../../role/roleTools.js';
import { registerAskMode } from './askMode.js';
import { isFinalHandover } from './queuedHandover.js';
import { endArchitectSession, startArchitectSession } from './session.js';
import type { ArchitectSession } from './session.js';
import { createArchitectTool } from './tool.js';

export default function architectExtension(pi: ExtensionAPI): void {
  // oxlint-disable-next-line node/no-process-env -- The ask terminal receives its record path in its environment.
  const askRecordPath = process.env.TAU_ARCHITECT_ASK;

  if (askRecordPath !== undefined && askRecordPath !== '') {
    registerAskMode(pi, askRecordPath);
  } else if (currentRole() === 'architect') {
    pi.on('tool_result', (event, context) => {
      if (isFinalHandover(event)) {
        context.shutdown();
      }
    });
  }

  if (roleRegistersTool(currentRole(), 'architect')) {
    pi.registerTool(createArchitectTool({ exec: piExec(pi), connect, cwd: process.cwd() }));
  }

  let session: ArchitectSession | undefined;

  pi.on('session_start', async (_event, context) => {
    session = await startArchitectSession(context);
  });

  pi.on('session_shutdown', async () => {
    const ending = session;

    session = undefined;

    if (ending !== undefined) {
      await endArchitectSession(ending);
    }
  });
}
