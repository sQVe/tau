import { join } from 'node:path';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import type { FauxResponseStep, TranscriptContext } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import planExtension from '../src/extensions/plan/plan.js';
import type { PlanStep } from '../src/extensions/plan/steps.js';
import { createBoundSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const mixedPlan: PlanStep[] = [
  { text: 'Brief worker', status: 'completed' },
  { text: 'Review change', status: 'in_progress' },
  { text: 'Open the PR', status: 'pending' },
];

const finishedPlan: PlanStep[] = mixedPlan.map((step) => ({ ...step, status: 'completed' }));

// Long enough that the newest user turn alone crosses `keepRecentTokens`.
const secondPrompt =
  'Summarise the saved plan in one sentence, keeping every step and its status in the answer.';

const setup = async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-plan-prompt-');

  vi.stubEnv('TAU_ROLE', 'lead');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const provider = fauxProvider({ provider: 'tau-plan-prompt' });
  const errors: unknown[] = [];

  onTestFinished(() => {
    expect(errors).toEqual([]);
  });

  const { session } = await createBoundSession(
    onTestFinished,
    {
      cwd: directory,
      agentDirectory: directory,
      providers: [provider],
      tools: ['plan'],
      settings: { compaction: { enabled: false, keepRecentTokens: 12 }, retry: { enabled: false } },
      sessionManager: SessionManager.create(directory, join(directory, 'sessions')),
      extensionFactories: [planExtension],
    },
    { onError: (error) => errors.push(error) },
  );

  return { provider, session };
};

const capturing =
  (prompts: string[], response: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
  (context: TranscriptContext) => {
    prompts.push(getCurrentSystemPrompt(context.messages));

    return response;
  };

const savePlan = (prompts: string[], steps: PlanStep[]): FauxResponseStep[] => [
  capturing(prompts, fauxAssistantMessage([fauxToolCall('plan', { steps })])),
  capturing(prompts, fauxAssistantMessage('Plan saved.')),
];

it('keeps the lead plan in the system prompt on every run, including after compaction', async () => {
  const { provider, session } = await setup();
  const prompts: string[] = [];

  provider.setResponses(savePlan(prompts, mixedPlan));
  await session.prompt('Save the plan.');

  expect(prompts).toHaveLength(2);
  expect(prompts[0]).not.toContain('Current plan:');
  expect(prompts[1]).not.toContain('Current plan:');

  provider.setResponses([capturing(prompts, fauxAssistantMessage('Noted.'))]);
  await session.prompt(secondPrompt);

  expect(prompts[2]).toContain('Current plan:');
  expect(prompts[2]).toContain('[in_progress] Review change');

  provider.setResponses([fauxAssistantMessage('The user saved a mixed plan and asked for it.')]);
  await session.compact();

  provider.setResponses([capturing(prompts, fauxAssistantMessage('Noted.'))]);
  await session.prompt('Continue.');

  expect(prompts[3]).toContain('Current plan:');
  expect(prompts[3]).toContain('[in_progress] Review change');

  provider.setResponses(savePlan(prompts, finishedPlan));
  await session.prompt('Finish the plan.');

  provider.setResponses([capturing(prompts, fauxAssistantMessage('Noted.'))]);
  await session.prompt('Continue.');

  expect(prompts.at(-1)).not.toContain('Current plan:');
});
