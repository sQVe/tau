import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import askUserQuestionExtension from './askUserQuestion/index.js';
import codingExtension from './coding/index.js';
import commitExtension from './commit/index.js';
import snippetsExtension from './snippets/index.js';
import statusbarExtension from './statusbar/index.js';
import tddExtension from './tdd/index.js';
import webAccessExtension from './webAccess/index.js';
import writingExtension from './writing/index.js';

export default async function tauExtension(extensionApi: ExtensionAPI) {
  await writingExtension(extensionApi);
  await codingExtension(extensionApi);

  commitExtension(extensionApi);
  tddExtension(extensionApi);
  askUserQuestionExtension(extensionApi);
  webAccessExtension(extensionApi);
  snippetsExtension(extensionApi);
  statusbarExtension(extensionApi);
}
