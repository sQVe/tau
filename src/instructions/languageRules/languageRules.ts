import type { ContextEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { guideSection } from '../guideRuns.js';
import type { GuideRuns } from '../guideRuns.js';
import type { GuideLanguage } from '../stommeGuides/stommeGuidesDecision.js';
import { appendSystemPrompt } from '../systemPrompt.js';
import {
  classifyLanguageActivation,
  commandOutcome,
  languageRulesTypes,
  languageToolDecision,
} from './languageRulesDecision.js';
import type { CommandOutcome } from './languageRulesDecision.js';

interface RulesState {
  active: boolean;
  systemPromptLoaded: boolean;
  requestLoaded: boolean;
}

type BundleSnapshot = Extract<Awaited<ReturnType<GuideRuns['snapshot']>>, { kind: 'bundle' }>;

type CommandNotice = Extract<CommandOutcome<BundleSnapshot>, { kind: 'notice' }>;

const languages: readonly GuideLanguage[] = ['typescript', 'rust'];

const labels: Readonly<Record<GuideLanguage, string>> = {
  typescript: 'TypeScript',
  rust: 'Rust',
};

const commandNames: Readonly<Record<GuideLanguage, string>> = {
  typescript: 'typescript-rules',
  rust: 'rust-rules',
};

const rulesText = (snapshot: BundleSnapshot, language: GuideLanguage): string =>
  guideSection(snapshot, snapshot.languageGuides[language]);

const isRulesMessage = (message: ContextEvent['messages'][number], language: GuideLanguage) =>
  message.role === 'custom' && message.customType === languageRulesTypes[language];

const sendRules = (pi: ExtensionAPI, language: GuideLanguage, rules: string): void => {
  pi.sendMessage(
    {
      customType: languageRulesTypes[language],
      content: rules,
      display: false,
    },
    { deliverAs: 'steer' },
  );
};

const activate = (pi: ExtensionAPI, language: GuideLanguage, state: RulesState): boolean => {
  if (state.active) {
    return false;
  }

  pi.appendEntry(languageRulesTypes[language], { version: 1 });
  state.active = true;

  return true;
};

const noticeFor = (
  label: string,
  entry: { kind: 'newer'; version: number } | { kind: 'malformed' },
) =>
  entry.kind === 'newer'
    ? `${label} rules activation uses newer version ${entry.version}. Restart the session with an updated Tau to read it.`
    : `Malformed ${label} rules activation entry was ignored.`;

const rebuildState = (
  language: GuideLanguage,
  state: RulesState,
  context: ExtensionContext,
): void => {
  const activation = classifyLanguageActivation(context.sessionManager.getBranch(), language);

  state.active = activation.active;
  state.systemPromptLoaded = false;
  state.requestLoaded = false;

  for (const entry of activation.unreadable) {
    context.ui.notify(noticeFor(labels[language], entry), 'warning');
  }
};

const bundleSnapshot = async (guideRuns: GuideRuns): Promise<BundleSnapshot | undefined> => {
  const snapshot = await guideRuns.snapshot();

  return snapshot.kind === 'bundle' ? snapshot : undefined;
};

const registerLifecycle = (
  pi: ExtensionAPI,
  guideRuns: GuideRuns,
  states: Readonly<Record<GuideLanguage, RulesState>>,
): void => {
  const rebuild = (_event: unknown, context: ExtensionContext) => {
    for (const language of languages) {
      rebuildState(language, states[language], context);
    }
  };

  pi.on('session_start', rebuild);
  pi.on('session_tree', rebuild);

  pi.on('before_agent_start', async (event) => {
    const snapshot = await bundleSnapshot(guideRuns);

    for (const language of languages) {
      const state = states[language];
      const appends = snapshot !== undefined && state.active;

      state.systemPromptLoaded = appends;
      state.requestLoaded = false;

      if (appends) {
        appendSystemPrompt(event, rulesText(snapshot, language));
      }
    }
  });

  pi.on('context', async (event) => {
    const snapshot = await bundleSnapshot(guideRuns);

    const supersededLanguages = languages.filter(
      (language) => snapshot === undefined || states[language].systemPromptLoaded,
    );

    const kept = event.messages.filter(
      (message) => !supersededLanguages.some((language) => isRulesMessage(message, language)),
    );

    if (snapshot !== undefined) {
      for (const language of languages) {
        const state = states[language];

        const messageLoaded = event.messages.some((message) => isRulesMessage(message, language));

        state.requestLoaded = state.systemPromptLoaded || messageLoaded;
      }
    }

    return kept.length === event.messages.length ? undefined : { messages: kept };
  });

  pi.on('session_compact', async (_event, context) => {
    const snapshot = await bundleSnapshot(guideRuns);

    if (snapshot === undefined || context.isIdle()) {
      return;
    }

    for (const language of languages) {
      const state = states[language];

      if (state.active && !state.systemPromptLoaded) {
        sendRules(pi, language, rulesText(snapshot, language));
      }
    }
  });
};

const gateLanguageTool = async (
  pi: ExtensionAPI,
  guideRuns: GuideRuns,
  state: RulesState,
  decision: { kind: 'activate' | 'block'; language: GuideLanguage },
) => {
  const snapshot = await bundleSnapshot(guideRuns);

  if (snapshot === undefined) {
    return undefined;
  }

  const { language } = decision;

  if (activate(pi, language, state)) {
    sendRules(pi, language, rulesText(snapshot, language));
  }

  if (decision.kind === 'block') {
    return {
      block: true,
      reason: `${labels[language]} rules are now loaded. Reconsider this change against them before retrying.`,
    };
  }

  return undefined;
};

const registerToolGate = (
  pi: ExtensionAPI,
  guideRuns: GuideRuns,
  states: Readonly<Record<GuideLanguage, RulesState>>,
): void => {
  pi.on('tool_call', (event) => {
    const path = 'path' in event.input ? event.input.path : undefined;

    const loaded = new Set(languages.filter((language) => states[language].requestLoaded));

    const decision = languageToolDecision(event.toolName, path, loaded);

    if (decision.kind === 'ignore') {
      return undefined;
    }

    return gateLanguageTool(pi, guideRuns, states[decision.language], decision);
  });
};

const plainNoticeTexts: Readonly<
  Record<'broken' | 'no-coding-set' | 'loaded', (label: string) => string>
> = {
  broken: (label) => `${label} rules are off, because Tau could not load the stomme guides.`,
  'no-coding-set': (label) =>
    `This session does not load the coding guides, so it has no ${label} guide.`,
  loaded: (label) => `The project's ${label} guide already loads with the coding guides.`,
};

const noticeText = (notice: CommandNotice, label: string): string =>
  notice.reason === 'other-language'
    ? `The project declares ${labels[notice.declared]}, so Tau loads no ${label} guide.`
    : plainNoticeTexts[notice.reason](label);

const commandSnapshot = (guideRuns: GuideRuns, idle: boolean) =>
  idle ? guideRuns.current() : guideRuns.snapshot();

const registerCommand = (
  pi: ExtensionAPI,
  guideRuns: GuideRuns,
  language: GuideLanguage,
  state: RulesState,
): void => {
  const label = labels[language];

  pi.registerCommand(commandNames[language], {
    description: `Load ${label} rules before shell-only ${label} work`,
    handler: async (_arguments, context) => {
      const idle = context.isIdle();
      const snapshot = await commandSnapshot(guideRuns, idle);

      const usesCodingSet = await guideRuns.usesCodingSet();

      const outcome = commandOutcome<BundleSnapshot>(snapshot, language, usesCodingSet);

      if (outcome.kind === 'notice') {
        context.ui.notify(noticeText(outcome, label), outcome.level);

        return;
      }

      activate(pi, language, state);

      if (!idle) {
        sendRules(pi, language, rulesText(outcome.bundle, language));
      }

      context.ui.notify(`${label} rules are active.`, 'info');
    },
  });
};

export const registerLanguageRules = (pi: ExtensionAPI, guideRuns: GuideRuns): void => {
  const states: Record<GuideLanguage, RulesState> = {
    typescript: {
      active: false,
      systemPromptLoaded: false,
      requestLoaded: false,
    },
    rust: { active: false, systemPromptLoaded: false, requestLoaded: false },
  };

  registerLifecycle(pi, guideRuns, states);
  registerToolGate(pi, guideRuns, states);

  for (const language of languages) {
    registerCommand(pi, guideRuns, language, states[language]);
  }
};
