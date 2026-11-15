import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { piExec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import { createHandoverTool } from './tool.js';

export default function handoverExtension(pi: ExtensionAPI): void {
  pi.registerTool(createHandoverTool({ exec: piExec(pi), connect, cwd: process.cwd() }));
}
