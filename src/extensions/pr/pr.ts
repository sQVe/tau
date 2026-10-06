import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createPrTool } from './tool.js';

export default function prExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    createPrTool((command, commandArguments, options) =>
      pi.exec(command, commandArguments, options),
    ),
  );
}
