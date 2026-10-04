import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createSliceTool } from './tool.js';

export default function sliceExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    createSliceTool((command, commandArguments, options) =>
      pi.exec(command, commandArguments, options),
    ),
  );
}
