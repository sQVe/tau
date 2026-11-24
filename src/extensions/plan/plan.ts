import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { appendToolGuidelines } from '../../instructions/systemPrompt.js';
import { currentRole } from '../../role/role.js';
import { roleRegistersTool } from '../../role/roleTools.js';
import { replayPlan } from './steps.js';
import { createPlanTool, planToolGuidelines } from './tool.js';
import { drawPlan } from './widget.js';

const drawSavedPlan = (context: ExtensionContext): void => {
  const { steps, unreadable } = replayPlan(context.sessionManager.getBranch());

  drawPlan(context, steps);

  for (const entry of unreadable) {
    const notice =
      entry.kind === 'newer'
        ? `Skipped a plan entry from newer version ${entry.version}.`
        : 'Skipped a malformed plan entry.';

    context.ui.notify(notice, 'warning');
  }
};

export default function planExtension(pi: ExtensionAPI): void {
  if (!roleRegistersTool(currentRole(), 'plan')) {
    return;
  }

  pi.registerTool(createPlanTool(pi));
  appendToolGuidelines(pi, 'plan', planToolGuidelines);

  const handler = (_event: unknown, context: ExtensionContext) => {
    drawSavedPlan(context);
  };

  pi.on('session_start', handler);
  pi.on('session_tree', handler);
}
