import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { holdSessionLock, refusalMessage, switchRefusal } from './hold.js';

const exitAfterRefusal = async (context: ExtensionContext, message: string): Promise<never> => {
  context.ui.notify(message, 'error');

  process.once('exit', () => {
    process.stderr.write(`${message}\n`);
  });

  context.shutdown();

  // Pi runs the remaining session_start handlers once this one settles, so it must not settle.
  const never = Promise.withResolvers<never>();

  return never.promise;
};

export default function sessionLockExtension(pi: ExtensionAPI): void {
  let release: (() => Promise<void>) | undefined;

  pi.on('session_start', async (_event, context) => {
    const sessionFile = context.sessionManager.getSessionFile();

    try {
      const held = await holdSessionLock(sessionFile, context.cwd);

      if (held.kind === 'held') {
        release = held.release;
      }

      if (held.kind === 'refused' && sessionFile !== undefined) {
        await exitAfterRefusal(context, refusalMessage(sessionFile, held.holder));
      }
    } catch (error) {
      context.ui.notify(`Session lock failed: ${errorMessage(error)}`, 'warning');
    }
  });

  pi.on('session_before_switch', async (event, context) => {
    if (event.reason !== 'resume' || event.targetSessionFile === undefined) {
      return undefined;
    }

    try {
      const message = await switchRefusal(event.targetSessionFile);

      if (message === undefined) {
        return undefined;
      }

      context.ui.notify(message, 'error');

      return { cancel: true };
    } catch (error) {
      context.ui.notify(`Session lock failed: ${errorMessage(error)}`, 'warning');

      return undefined;
    }
  });

  pi.on('session_shutdown', async () => {
    const releasing = release;

    release = undefined;
    await releasing?.();
  });
}
