import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createStatusbarFooter } from './footer.js';

export default function statusbarExtension(pi: ExtensionAPI): void {
  const footer = createStatusbarFooter(pi);

  pi.on('session_start', (_event, context) => {
    if (context.mode !== 'tui') {
      return;
    }

    footer.install(context);
  });

  // Pi awaits tool_result handlers, so footer reads must run in the background.
  pi.on('tool_result', (_event, context) => {
    if (context.mode === 'tui') {
      footer.refreshAfterToolResult(context);
    }
  });
}
