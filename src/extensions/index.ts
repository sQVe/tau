import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import commitExtension from './commit/index.js';

export default function tauExtension(pi: ExtensionAPI) {
  commitExtension(pi);
}
