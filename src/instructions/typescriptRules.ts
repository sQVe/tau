import { readFileSync } from 'node:fs';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { appendSystemPrompt } from './systemPrompt.js';
import {
  classifyTypeScriptActivation,
  typeScriptRulesType,
  typeScriptToolDecision,
} from './typescriptRulesDecision.js';

interface RulesState {
  active: boolean;
  systemPromptLoaded: boolean;
  requestLoaded: boolean;
}

const sendRules = (pi: ExtensionAPI, rules: string): void => {
  pi.sendMessage(
    { customType: typeScriptRulesType, content: rules, display: false },
    { deliverAs: 'steer' },
  );
};

const activate = (pi: ExtensionAPI, state: RulesState): boolean => {
  if (state.active) {
    return false;
  }

  pi.appendEntry(typeScriptRulesType, { version: 1 });
  state.active = true;

  return true;
};

const registerLifecycle = (pi: ExtensionAPI, state: RulesState, rules: string): void => {
  const rebuild = (_event: unknown, context: ExtensionContext) => {
    const activation = classifyTypeScriptActivation(context.sessionManager.getBranch());

    state.active = activation.active;
    state.systemPromptLoaded = false;
    state.requestLoaded = false;

    for (const entry of activation.unreadable) {
      if (entry.kind === 'newer') {
        context.ui.notify(
          `TypeScript rules activation uses newer version ${entry.version}. Restart the session with an updated Tau to read it.`,
          'warning',
        );
      } else {
        context.ui.notify('Malformed TypeScript rules activation entry was ignored.', 'warning');
      }
    }
  };

  pi.on('session_start', rebuild);
  pi.on('session_tree', rebuild);

  pi.on('before_agent_start', (event) => {
    state.systemPromptLoaded = state.active;
    state.requestLoaded = false;

    if (state.active) {
      appendSystemPrompt(event, rules);
    }
  });

  pi.on('context', (event) => {
    const messageLoaded = event.messages.some(
      (message) => message.role === 'custom' && message.customType === typeScriptRulesType,
    );

    state.requestLoaded = state.systemPromptLoaded || messageLoaded;
  });

  pi.on('session_compact', (_event, context) => {
    if (!state.active || state.systemPromptLoaded || context.isIdle()) {
      return;
    }

    sendRules(pi, rules);
  });
};

export const registerTypeScriptRules = (pi: ExtensionAPI): void => {
  const rules = readFileSync(new URL('./typescript.md', import.meta.url), 'utf8');
  const state: RulesState = { active: false, systemPromptLoaded: false, requestLoaded: false };

  registerLifecycle(pi, state, rules);

  pi.on('tool_call', (event) => {
    const path = 'path' in event.input ? event.input.path : undefined;
    const decision = typeScriptToolDecision(event.toolName, path, state.requestLoaded);

    if (decision === 'ignore') {
      return undefined;
    }

    if (activate(pi, state)) {
      sendRules(pi, rules);
    }

    if (decision === 'block') {
      return {
        block: true,
        reason:
          'TypeScript rules are now loaded. Reconsider this change against them before retrying.',
      };
    }

    return undefined;
  });

  pi.registerCommand('typescript-rules', {
    description: 'Load TypeScript rules before shell-only TypeScript work',
    handler: (_arguments, context) => {
      activate(pi, state);

      if (!context.isIdle()) {
        sendRules(pi, rules);
      }

      context.ui.notify('TypeScript rules are active.', 'info');

      return Promise.resolve();
    },
  });
};
