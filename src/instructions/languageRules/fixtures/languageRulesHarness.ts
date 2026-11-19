import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';
import type { Mock, TestContext } from 'vitest';

import { fakeExtensionApi } from '../../../../tests/extensionApi.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { trackGuideRuns } from '../../guideRuns.js';
import type { GuideLanguage } from '../../stommeGuides/stommeGuidesDecision.js';
import { registerLanguageRules } from '../languageRules.js';

export interface Case {
  language: GuideLanguage;
  label: string;
  customType: string;
  path: string;
  command: string;
}

interface SetupOptions {
  usesCodingSet?: () => Promise<boolean>;
}

export interface LanguageRulesFixture {
  api: ReturnType<typeof fakeExtensionApi>;
  appendEntry: Mock<ExtensionAPI['appendEntry']>;
  sessionManager: SessionManager;
  idle: Mock<ExtensionContext['isIdle']>;
  notify: Mock<ExtensionContext['ui']['notify']>;
  context: ExtensionContext;
  directory: string;
  emit: (
    name: string,
    event?: Record<string, unknown>,
  ) => Promise<{ results: unknown[]; event: Record<string, unknown> }>;
  call: (toolName: string, path: string, parentToolCallId?: string) => Promise<unknown[]>;
  prompt: () => Promise<string>;
  request: (messages?: unknown[]) => Promise<Record<string, unknown>>;
}

export const languageCases: Case[] = [
  {
    language: 'typescript',
    label: 'TypeScript',
    customType: 'tau-typescript-rules',
    path: 'main.ts',
    command: 'typescript-rules',
  },
  {
    language: 'rust',
    label: 'Rust',
    customType: 'tau-rust-rules',
    path: 'src/lib.rs',
    command: 'rust-rules',
  },
];

const bundleDirectory = fileURLToPath(new URL('../../../../vendor/stomme', import.meta.url));

export const bundledRules = (language: GuideLanguage): string => {
  const path = `languages/${language}/guide.md`;
  const text = readFileSync(join(bundleDirectory, path), 'utf8');

  return `Source: ${bundleDirectory}/${path}\n\n${text.trim()}`;
};

export const setupLanguageRules = async (
  onTestFinished: TestContext['onTestFinished'],
  options: SetupOptions = {},
): Promise<LanguageRulesFixture> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-language-rules-');
  const sessionManager = SessionManager.inMemory();

  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>((type, data) => {
    sessionManager.appendCustomEntry(type, data);
  });

  const api = fakeExtensionApi({ appendEntry });
  const idle = vi.fn<ExtensionContext['isIdle']>(() => false);
  const notify = vi.fn<ExtensionContext['ui']['notify']>();

  const context = {
    cwd: directory,
    sessionManager,
    isIdle: idle,
    ui: { notify },
  } as unknown as ExtensionContext;

  const guideRuns = trackGuideRuns(api.pi, options);

  registerLanguageRules(api.pi, guideRuns);

  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    const results: unknown[] = [];
    const current = { ...event };

    for (const handler of api.handlers.get(name) ?? []) {
      const result = await handler(current as never, context);

      results.push(result);

      if (name === 'context' && typeof result === 'object' && result !== null) {
        Object.assign(current, result);
      }
    }

    return { results, event: current };
  };

  const call = async (toolName: string, path: string, parentToolCallId?: string) =>
    (await emit('tool_call', { toolName, input: { path }, parentToolCallId })).results;

  const prompt = async () => {
    const { event } = await emit('before_agent_start', {
      systemPromptOptions: {
        appendSystemPrompt: '',
        selectedTools: ['read', 'edit', 'write'],
      },
    });

    const promptOptions = event['systemPromptOptions'] as {
      appendSystemPrompt: string;
    };

    return promptOptions.appendSystemPrompt;
  };

  const request = async (messages: unknown[] = []) => (await emit('context', { messages })).event;

  await emit('session_start', { reason: 'startup' });

  return {
    api,
    appendEntry,
    sessionManager,
    idle,
    notify,
    context,
    directory,
    emit,
    call,
    prompt,
    request,
  };
};

export const runLanguageCommand = async (
  fixture: LanguageRulesFixture,
  command: string,
): Promise<void> => {
  await fixture.api.commands.get(command)?.handler('', fixture.context as ExtensionCommandContext);
};

export const delivered = (
  customType: string,
  content: string,
): { customType: string; content: string; display: false } => ({
  customType,
  content,
  display: false,
});
