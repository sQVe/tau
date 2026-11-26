import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { decideDetachedOutput } from './detachedOutputDecision.js';

export default function bashGuard(pi: ExtensionAPI): void {
  pi.on('tool_call', (event) => {
    if (!isToolCallEventType('bash', event)) {
      return undefined;
    }

    return decideDetachedOutput({ toolName: event.toolName, command: event.input.command });
  });
}
