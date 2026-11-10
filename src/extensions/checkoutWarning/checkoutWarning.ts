import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { runGit } from '../../git.js';
import { isWorkerProcess } from '../../worker.js';
import { checkoutWarningMessage } from './message.js';

export default function checkoutWarningExtension(pi: ExtensionAPI, checkout: string): void {
  pi.on('session_start', async (_event, context) => {
    if (isWorkerProcess()) {
      return;
    }

    const result = await runGit(checkout, ['rev-list', '--count', 'HEAD..@{upstream}'], {
      timeoutMilliseconds: 5000,
    });

    const message = checkoutWarningMessage({
      exitCode: result.exitCode,
      stdout: result.stdout.toString('utf8'),
      checkout,
    });

    if (message !== undefined) {
      context.ui.notify(message, 'warning');
    }
  });
}
