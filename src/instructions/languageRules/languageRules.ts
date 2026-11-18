import type { ContextEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { guideSection } from '../guideRuns.js';
import type { GuideRuns } from '../guideRuns.js';
import type { GuideSnapshot } from '../stommeGuides/stommeGuides.js';
import type { GuideLanguage } from '../stommeGuides/stommeGuidesDecision.js';
import { appendSystemPrompt } from '../systemPrompt.js';
import {
  classifyLanguageActivation,
  commandOutcome,
  languageRulesTypes,
  languageToolDecision,
} from './languageRulesDecision.js';
import type { CommandMode, CommandOutcome } from './languageRulesDecision.js';

interface RulesState {
  active: boolean;
  systemPromptLoaded: boolean;
  requestLoaded: boolean;
}

type BundleSnapshot = Extract<Awaited<ReturnType<GuideRuns['snapshot']>>, { kind: 'bundle' }>;

type NoticeReason = Extract<CommandOutcome, { kind: 'notice' }>['reason'];

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
    { customType: languageRulesTypes[language], content: rules, display: false },
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

    // A language whose guide is in the append section does not need its saved rules message. Outside
    // bundle mode no rules message belongs in the request.
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

// Returns before any await for an ignored call, so other tool_call handlers keep their order.
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

const noticeTexts: Readonly<
  Record<NoticeReason, (label: string, declaredLabel: string) => string>
> = {
  broken: (label) => `${label} rules are off, because Tau could not load the stomme guides.`,
  'no-coding-set': (label) =>
    `This session does not load the coding guides, so it has no ${label} guide.`,
  'other-language': (label, declaredLabel) =>
    `The project declares ${declaredLabel}, so Tau loads no ${label} guide.`,
  loaded: (label) => `The project's ${label} guide already loads with the coding guides.`,
};

const commandMode = (snapshot: GuideSnapshot): CommandMode =>
  snapshot.kind === 'project'
    ? { kind: 'project', declared: snapshot.language }
    : { kind: snapshot.kind };

// A busy session keeps the run's snapshot, so the command does not mix two guide versions. An idle
// session has no run to keep, so it reads the guides now.
const commandSnapshot = (guideRuns: GuideRuns, context: ExtensionContext) =>
  context.isIdle() ? guideRuns.current() : guideRuns.snapshot();

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
      const snapshot = await commandSnapshot(guideRuns, context);

      const mode = commandMode(snapshot);
      const outcome = commandOutcome(mode, language, await guideRuns.usesCodingSet());

      if (outcome.kind === 'notice') {
        const declaredLabel = mode.kind === 'project' ? labels[mode.declared] : '';
        const text = noticeTexts[outcome.reason](label, declaredLabel);

        context.ui.notify(text, outcome.level);

        return;
      }

      if (snapshot.kind !== 'bundle') {
        return;
      }

      activate(pi, language, state);

      if (!context.isIdle()) {
        sendRules(pi, language, rulesText(snapshot, language));
      }

      context.ui.notify(`${label} rules are active.`, 'info');
    },
  });
};

// Register after `trackGuideRuns`, so each handler reads the snapshot of the run that just started.
export const registerLanguageRules = (pi: ExtensionAPI, guideRuns: GuideRuns): void => {
  const states: Record<GuideLanguage, RulesState> = {
    typescript: { active: false, systemPromptLoaded: false, requestLoaded: false },
    rust: { active: false, systemPromptLoaded: false, requestLoaded: false },
  };

  registerLifecycle(pi, guideRuns, states);
  registerToolGate(pi, guideRuns, states);

  for (const language of languages) {
    registerCommand(pi, guideRuns, language, states[language]);
  }
};
