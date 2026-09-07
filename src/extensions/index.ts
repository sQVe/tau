import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import commitExtension from './commit/index.js';
import writingExtension from './writing/index.js';

export default async function tauExtension(pi: ExtensionAPI) {
  await writingExtension(pi);
  commitExtension(pi);
}
