import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import commitExtension from './commit/index.js';
import tddExtension from './tdd/index.js';
import writingExtension from './writing/index.js';

export default async function tauExtension(pi: ExtensionAPI) {
  await writingExtension(pi);
  commitExtension(pi);
  tddExtension(pi);
}
