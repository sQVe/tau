import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { piExec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import { currentRole } from '../../role/role.js';
import { createSessionResume } from './sessionResume.js';

export default function piResumeExtension(pi: ExtensionAPI): void {
  const resume = createSessionResume(
    { exec: piExec(pi), connect, cwd: process.cwd() },
    currentRole(),
  );

  pi.on('session_start', async (_event, context) => {
    await resume.sessionStarted(context);
  });

  pi.on('session_shutdown', async () => {
    await resume.sessionShutdown();
  });
}
