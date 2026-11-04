import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import { createSessionResume } from './sessionResume.js';

const piExec =
  (pi: ExtensionAPI): Exec =>
  (command, commandArguments, options) =>
    pi.exec(command, commandArguments, options);

export default function piResumeExtension(pi: ExtensionAPI): void {
  const resume = createSessionResume({ exec: piExec(pi), connect, cwd: process.cwd() });

  pi.on('session_start', async (_event, context) => {
    await resume.sessionStarted(context);
  });

  pi.on('session_shutdown', async () => {
    await resume.sessionShutdown();
  });
}
