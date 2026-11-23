import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { appendToolGuidelines } from '../../instructions/systemPrompt.js';
import { currentRole } from '../../role/role.js';
import { roleRegistersTool } from '../../role/roleTools.js';
import { createPlanTool, planToolGuidelines } from './tool.js';

export default function planExtension(pi: ExtensionAPI): void {
  if (!roleRegistersTool(currentRole(), 'plan')) {
    return;
  }

  pi.registerTool(createPlanTool(pi));
  appendToolGuidelines(pi, 'plan', planToolGuidelines);
}
