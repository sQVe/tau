import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { decideDetachedOutput } from './detachedOutputDecision.js';

export default function bashGuard(pi: ExtensionAPI): void {
  pi.on('tool_call', (event) => {
    const command = 'command' in event.input ? event.input.command : undefined;

    return decideDetachedOutput({ toolName: event.toolName, command });
  });
}
