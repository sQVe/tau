import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { guidelineLines } from '../../instructions/systemPrompt.js';
import planExtension from './plan.js';
import type { PlanStep } from './steps.js';
import { planToolGuidelines } from './tool.js';

type Execute = ToolDefinition['execute'];

const step = (text: string, status: PlanStep['status'] = 'pending'): PlanStep => ({ text, status });

const lead = (overrides: Partial<ExtensionAPI> = {}) => {
  vi.stubEnv('TAU_ROLE', 'lead');
  const fake = fakeExtensionApi(overrides);
  planExtension(fake.pi);

  return fake;
};

const planTool = (fake: ReturnType<typeof fakeExtensionApi>): ToolDefinition => {
  const tool = fake.tools.get('plan');

  if (tool === undefined) {
    throw new Error('The extension registered no plan tool.');
  }

  return tool;
};

const run = (tool: ToolDefinition, steps: PlanStep[]) =>
  tool.execute('call', { steps }, undefined, undefined, {} as Parameters<Execute>[4]);

afterEach(() => {
  vi.unstubAllEnvs();
});

it('a refused call rejects and appends nothing', async () => {
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>();
  const tool = planTool(lead({ appendEntry }));
  const steps = [step('Brief worker', 'in_progress'), step('Review change', 'in_progress')];

  await expect(run(tool, steps)).rejects.toThrow(/in_progress/);
  expect(appendEntry).not.toHaveBeenCalled();
});

it('an accepted call appends one record and returns the summary', async () => {
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>();
  const tool = planTool(lead({ appendEntry }));

  const steps = [
    step('Brief worker for ME-123', 'completed'),
    step('Review worker change for ME-123', 'in_progress'),
    step('Open the PR'),
  ];

  const result = await run(tool, steps);

  expect(appendEntry).toHaveBeenCalledExactlyOnceWith('tau-plan', { version: 1, steps });
  expect(result.content).toEqual([{ type: 'text', text: 'Plan: 1 of 3 completed.' }]);
});

it.each(['architect', 'worker'] as const)(
  'registers no plan tool or handler for the %s role',
  (role) => {
    vi.stubEnv('TAU_ROLE', role);
    const fake = fakeExtensionApi();

    planExtension(fake.pi);

    expect(fake.tools.has('plan')).toBe(false);
    expect([...fake.handlers.keys()]).toEqual([]);
  },
);

it('adds the plan guidelines once without a message', () => {
  const fake = lead();
  const handler = fake.handler('before_agent_start');
  const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools: ['plan'] } };

  const result = handler(event, {} as ExtensionContext);

  expect(event.systemPromptOptions.appendSystemPrompt).toBe(guidelineLines(planToolGuidelines));
  expect(result).toBeUndefined();
  expect(fake.sendMessage).not.toHaveBeenCalled();
  expect(fake.sendUserMessage).not.toHaveBeenCalled();
  expect(fake.handlers.has('context')).toBe(false);
});
