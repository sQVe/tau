import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerHandBackReminder } from './handBackReminder.js';

export default function handBackExtension(pi: ExtensionAPI): void {
  registerHandBackReminder(pi);
}
