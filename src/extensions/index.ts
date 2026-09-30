import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import askUserQuestionExtension from './askUserQuestion/index.js';
import bareRootExtension from './bareRoot/index.js';
import bulkReadExtension from './bulkRead/index.js';
import codingExtension from './coding/index.js';
import commitExtension from './commit/index.js';
import herdrBlockedExtension from './herdrBlocked/index.js';
import skillCommandsExtension from './skillCommands/index.js';
import snippetsExtension from './snippets/index.js';
import statusbarExtension from './statusbar/index.js';
import subagentsExtension from './subagents/index.js';
import tddExtension from './tdd/index.js';
import webAccessExtension from './webAccess/index.js';
import workflowExtension from './workflow/index.js';
import writingExtension from './writing/index.js';

export default async function tauExtension(pi: ExtensionAPI) {
  await writingExtension(pi);
  await codingExtension(pi);
  await workflowExtension(pi);

  skillCommandsExtension(pi);
  commitExtension(pi);
  tddExtension(pi);
  bulkReadExtension(pi);
  askUserQuestionExtension(pi);
  webAccessExtension(pi);
  snippetsExtension(pi);
  statusbarExtension(pi);
  subagentsExtension(pi);
  bareRootExtension(pi);
  herdrBlockedExtension(pi);
}
