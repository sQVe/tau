import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createFooter } from './footer.js';

export default function statusbarExtension(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, context) => {
    if (context.mode === 'tui') {
      context.ui.setFooter(createFooter(pi, context));
    }
  });
}
