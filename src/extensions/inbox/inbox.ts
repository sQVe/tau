import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createStartupGate } from './startup.js';

export default function inboxExtension(pi: ExtensionAPI): void {
  createStartupGate(pi);
}
