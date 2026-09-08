import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import askUserQuestionExtension from './askUserQuestion/index.js';
import commitExtension from './commit/index.js';
import snippetsExtension from './snippets/index.js';
import tddExtension from './tdd/index.js';
import webAccessExtension from './webAccess/index.js';
import writingExtension from './writing/index.js';

export default async function tauExtension(pi: ExtensionAPI) {
  await writingExtension(pi);
  commitExtension(pi);
  tddExtension(pi);
  askUserQuestionExtension(pi);
  webAccessExtension(pi);
  snippetsExtension(pi);
}
