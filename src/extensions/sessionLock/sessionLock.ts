import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { guardResume, lockSessionOnStart, releaseSessionLock } from './hold.js';

export default function sessionLockExtension(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, context) => lockSessionOnStart(context));
  pi.on('session_before_switch', (event, context) => guardResume(event, context));
  pi.on('session_shutdown', (event) => releaseSessionLock(event.reason));
}
