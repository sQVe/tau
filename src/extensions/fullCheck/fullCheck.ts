import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { createMutationCheckTool } from './mutationTool.js';
import { createFullCheckTool } from './tool.js';

export default function fullCheckExtension(pi: ExtensionAPI): void {
  const exec: Exec = (command, commandArguments, options) =>
    pi.exec(command, commandArguments, options);

  pi.registerTool(createFullCheckTool({ exec }));
  pi.registerTool(createMutationCheckTool({ exec }));
}
