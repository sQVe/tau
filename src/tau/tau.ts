import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { forgetReportedWarnings } from '../config/config.js';
import architectExtension from '../extensions/architect/architect.js';
import askUserQuestionExtension from '../extensions/askUserQuestion/askUserQuestion.js';
import bareRootExtension from '../extensions/bareRoot.js';
import bashGuardExtension from '../extensions/bashGuard/bashGuard.js';
import checkoutWarningExtension from '../extensions/checkoutWarning/checkoutWarning.js';
import codemodeExtension from '../extensions/codemode.js';
import codeReviewExtension from '../extensions/codeReview/codeReview.js';
import commitExtension from '../extensions/commit/commit.js';
import compactionExtension from '../extensions/compaction/compaction.js';
import draftReviewExtension from '../extensions/draftReview/draftReview.js';
import fullCheckExtension from '../extensions/fullCheck/fullCheck.js';
import handBackExtension from '../extensions/handBack/handBack.js';
import handoverExtension from '../extensions/handover/handover.js';
import handoverQuestionExtension from '../extensions/handoverQuestion/handoverQuestion.js';
import improvementExtension from '../extensions/improvement/improvement.js';
import inboxExtension from '../extensions/inbox/inbox.js';
import instructionsExtension from '../extensions/instructions.js';
import mergeWatchExtension from '../extensions/mergeWatch/mergeWatch.js';
import modelFallbackExtension from '../extensions/modelFallback/modelFallback.js';
import piResumeExtension from '../extensions/piResume/piResume.js';
import planExtension, { currentRolePlanReportText } from '../extensions/plan/plan.js';
import prExtension from '../extensions/pr/pr.js';
import prFeedbackExtension from '../extensions/prFeedback/prFeedback.js';
import sessionLockExtension from '../extensions/sessionLock/sessionLock.js';
import sliceExtension from '../extensions/slice/slice.js';
import snippetsExtension from '../extensions/snippets/snippets.js';
import stackExtension from '../extensions/stack/stack.js';
import staticLoaderExtension from '../extensions/staticLoader.js';
import statusbarExtension from '../extensions/statusbar/statusbar.js';
import subagentsExtension, { registerCapacityRefusal } from '../extensions/subagents/subagents.js';
import tauSkillsExtension from '../extensions/tauSkills/tauSkills.js';
import tddExtension from '../extensions/tdd/tdd.js';
import toolResultRedactionExtension from '../extensions/toolResultRedaction/toolResultRedaction.js';
import trackerExtension from '../extensions/tracker/tracker.js';
import verificationExtension from '../extensions/verification/verification.js';
import webAccessExtension from '../extensions/webAccess.js';
import { strictToolRegistration } from '../schema.js';

const skillsDirectory = fileURLToPath(new URL('../skills/', import.meta.url));
const checkoutDirectory = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export default async function tauRegistration(pi: ExtensionAPI): Promise<void> {
  strictToolRegistration(pi);

  // Must be the first session_start handler, so a refused start runs no other handler.
  sessionLockExtension(pi);

  // Features report config notices in their own session_start handlers, so the new session must
  // forget the old notices before any of them runs.
  pi.on('session_start', (_event, context) => {
    forgetReportedWarnings(context.ui);
  });

  // Pi stops at the first blocking hook, so capacity refusal must run before other guards.
  const capacityRefusal = registerCapacityRefusal(pi);

  // It must be Tau's first tool_result handler, so Tau's later handlers and the full-output files
  // they save see redacted text.
  toolResultRedactionExtension(pi);
  bashGuardExtension(pi);

  await instructionsExtension(pi);
  codemodeExtension(pi);

  tauSkillsExtension(pi, skillsDirectory);
  commitExtension(pi);
  tddExtension(pi);
  askUserQuestionExtension(pi);
  webAccessExtension(pi);
  modelFallbackExtension(pi);
  snippetsExtension(pi);
  sliceExtension(pi);
  fullCheckExtension(pi);
  handoverExtension(pi);
  handBackExtension(pi);
  // The handover question extension sets the session directory that the inbox's accept check
  // reads, so it must register before the inbox.
  handoverQuestionExtension(pi);
  inboxExtension(pi);
  architectExtension(pi);
  draftReviewExtension(pi);
  trackerExtension(pi);
  verificationExtension(pi);
  piResumeExtension(pi);
  prExtension(pi);
  prFeedbackExtension(pi);
  mergeWatchExtension(pi);
  stackExtension(pi);
  codeReviewExtension(pi);
  improvementExtension(pi);
  staticLoaderExtension(pi);
  statusbarExtension(pi);
  planExtension(pi);
  subagentsExtension(pi, capacityRefusal, currentRolePlanReportText);
  compactionExtension(pi);
  bareRootExtension(pi);
  checkoutWarningExtension(pi, checkoutDirectory);
}
