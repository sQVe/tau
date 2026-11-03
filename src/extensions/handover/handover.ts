import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import { createHandoverTool } from './tool.js';

const piExec =
  (pi: ExtensionAPI): Exec =>
  (command, commandArguments, options) =>
    pi.exec(command, commandArguments, options);

export default function handoverExtension(pi: ExtensionAPI): void {
  pi.registerTool(createHandoverTool({ exec: piExec(pi), connect, cwd: process.cwd() }));
}
