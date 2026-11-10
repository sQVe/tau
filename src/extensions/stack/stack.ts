import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createStackBranchTool } from './branchTool.js';
import { createStackTool } from './tool.js';

export default function stackExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    createStackBranchTool((command, commandArguments, options) =>
      pi.exec(command, commandArguments, options),
    ),
  );

  pi.registerTool(
    createStackTool((command, commandArguments, options) =>
      pi.exec(command, commandArguments, options),
    ),
  );
}
