import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createDelivery } from './delivery.js';
import { createMergeWatches } from './watches.js';

export default function mergeWatchExtension(pi: ExtensionAPI): void {
  const watches = createMergeWatches(
    (command, commandArguments, options) => pi.exec(command, commandArguments, options),
    createDelivery(pi),
  );

  // Pi awaits tool_result handlers, so the watch reads gh in the background.
  pi.on('tool_result', (event, context) => {
    watches.observe(event, context);
  });

  pi.on('session_shutdown', () => {
    watches.stopAll();
  });
}
