import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { guidelineLines } from '../../instructions/systemPrompt.js';
import planExtension from './plan.js';
import type { PlanStep } from './steps.js';
import { planEntryType } from './steps.js';
import { planToolGuidelines } from './tool.js';
import { planWidgetKey } from './widget.js';

type Execute = ToolDefinition['execute'];
type WidgetContent = Parameters<ExtensionContext['ui']['setWidget']>[1];

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

const planContext = (options: { mode?: ExtensionContext['mode']; branch?: unknown[] } = {}) => {
  const widgets: { key: string; content: WidgetContent }[] = [];
  const notify = vi.fn<ExtensionContext['ui']['notify']>();

  const context = {
    mode: options.mode ?? 'tui',
    ui: {
      setWidget: (key: string, content: WidgetContent) => {
        widgets.push({ key, content });
      },
      notify,
    },
    sessionManager: { getBranch: () => options.branch ?? [] },
  } as unknown as ExtensionContext;

  return { context, widgets, notify };
};

const runIn = (tool: ToolDefinition, steps: PlanStep[], context: ExtensionContext) =>
  tool.execute('call', { steps }, undefined, undefined, context as Parameters<Execute>[4]);

const widgetTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

const renderedLines = (content: WidgetContent): readonly string[] => {
  if (content === undefined) {
    return [];
  }

  if (typeof content === 'function') {
    return content({} as TUI, widgetTheme).render(80);
  }

  return content;
};

// The border line and the step indent have their own layout test in widget.test.ts.
const restoredSteps = (content: WidgetContent): readonly string[] =>
  renderedLines(content)
    .slice(1)
    .map((line) => line.trimStart());

const savedEntry = (data: unknown) => ({ type: 'custom', customType: planEntryType, data });

const saved = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'planRecord', name), 'utf8'),
  ) as unknown;

const replayBranch = (eventName: 'session_start' | 'session_tree', branch: unknown[]) => {
  const fake = lead();
  const session = planContext({ branch });

  fake.handler(eventName)({ type: eventName }, session.context);

  return session;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

it('registers the plan tool for the model only', () => {
  const tool = planTool(lead());

  expect(tool.exposure).toBe('model-only');
});

it('a refused call rejects, appends nothing, and leaves the widget unchanged', async () => {
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>();
  const tool = planTool(lead({ appendEntry }));
  const { context, widgets } = planContext();
  const steps = [step('Brief worker', 'in_progress'), step('Review change', 'in_progress')];

  await expect(runIn(tool, steps, context)).rejects.toThrow(/in_progress/);
  expect(appendEntry).not.toHaveBeenCalled();
  expect(widgets).toEqual([]);
});

it('an accepted call appends one record, returns the summary, and shows the steps', async () => {
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>();
  const tool = planTool(lead({ appendEntry }));
  const { context, widgets } = planContext();

  const steps = [
    step('Brief worker for ME-123', 'in_progress'),
    step('Review worker change for ME-123'),
    step('Open the PR', 'completed'),
  ];

  const result = await runIn(tool, steps, context);

  expect(appendEntry).toHaveBeenCalledExactlyOnceWith('tau-plan', { version: 1, steps });
  expect(result.content).toEqual([{ type: 'text', text: 'Plan: 1 of 3 completed.' }]);
  expect(widgets.map(({ key }) => key)).toEqual([planWidgetKey]);

  expect(renderedLines(widgets.at(-1)?.content)).toEqual([
    `── Plan ${'─'.repeat(72)}`,
    ' \u{F192} Brief worker for ME-123',
    ' \u{F10C} Review worker change for ME-123',
    ' \u{F058} Open the PR',
  ]);
});

it('fails the call and leaves the widget unchanged when saving throws', () => {
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>(() => {
    throw new Error('The plan could not be saved.');
  });

  const tool = planTool(lead({ appendEntry }));
  const { context, widgets } = planContext();

  expect(() => runIn(tool, [step('Brief worker')], context)).toThrow(
    'The plan could not be saved.',
  );

  expect(widgets).toEqual([]);
});

const hiddenCases: { name: string; steps: PlanStep[] }[] = [
  {
    name: 'an all-completed list',
    steps: [step('Brief worker', 'completed'), step('Open the PR', 'completed')],
  },
  { name: 'an empty list', steps: [] },
];

it.each(hiddenCases)('hides the widget for $name', async ({ steps }) => {
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>();
  const tool = planTool(lead({ appendEntry }));
  const { context, widgets } = planContext();

  await runIn(tool, steps, context);

  expect(widgets).toEqual([{ key: planWidgetKey, content: undefined }]);
});

it.each(['rpc', 'print'] as const)(
  'saves an accepted plan without a widget in %s mode',
  async (mode) => {
    const appendEntry = vi.fn<ExtensionAPI['appendEntry']>();
    const tool = planTool(lead({ appendEntry }));
    const { context, widgets } = planContext({ mode });

    await runIn(tool, [step('Brief worker')], context);

    expect(appendEntry).toHaveBeenCalledOnce();
    expect(widgets).toEqual([]);
  },
);

it.each(['session_start', 'session_tree'] as const)(
  'renders the last valid plan on %s',
  (eventName) => {
    const branch = [
      savedEntry({ version: 1, steps: [step('First')] }),
      savedEntry({ version: 1, steps: [step('Second'), step('Third', 'completed')] }),
    ];

    const { widgets } = replayBranch(eventName, branch);

    expect(restoredSteps(widgets.at(-1)?.content)).toEqual(['\u{F10C} Second', '\u{F058} Third']);
  },
);

it.each(['session_start', 'session_tree'] as const)(
  'clears the widget on %s without a plan entry',
  (eventName) => {
    const { widgets } = replayBranch(eventName, []);

    expect(widgets).toEqual([{ key: planWidgetKey, content: undefined }]);
  },
);

it.each(['session_start', 'session_tree'] as const)(
  'keeps the valid plan and warns once on %s for newer data',
  (eventName) => {
    const branch = [
      savedEntry({ version: 1, steps: [step('Kept')] }),
      savedEntry(saved('newer.json')),
    ];

    const { widgets, notify } = replayBranch(eventName, branch);

    expect(restoredSteps(widgets.at(-1)?.content)).toEqual(['\u{F10C} Kept']);

    expect(notify).toHaveBeenCalledExactlyOnceWith(
      'Skipped a plan entry from newer version 2.',
      'warning',
    );
  },
);

it.each(['session_start', 'session_tree'] as const)(
  'keeps the valid plan and warns once on %s for malformed data',
  (eventName) => {
    const branch = [
      savedEntry({ version: 1, steps: [step('Kept')] }),
      savedEntry(saved('malformed.json')),
    ];

    const { widgets, notify } = replayBranch(eventName, branch);

    expect(restoredSteps(widgets.at(-1)?.content)).toEqual(['\u{F10C} Kept']);

    expect(notify).toHaveBeenCalledExactlyOnceWith('Skipped a malformed plan entry.', 'warning');
  },
);

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
