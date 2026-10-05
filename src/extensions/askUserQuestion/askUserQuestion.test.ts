import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import askUserQuestionExtension from './askUserQuestion.js';
import type { DialogResult } from './dialog.js';

const registeredTool = () => {
  const tools: ToolDefinition[] = [];
  const pi = { on: () => undefined, registerTool: (tool: ToolDefinition) => tools.push(tool) };

  askUserQuestionExtension(pi as unknown as ExtensionAPI);

  const [tool] = tools;

  if (tool === undefined) {
    throw new Error('The extension registered no tool.');
  }

  return tool;
};

// Pi checks the schema before it runs the tool, so the call goes through the same check.
const ask = (question: Record<string, unknown>) => {
  const tool = registeredTool();

  const custom = vi
    .fn<() => Promise<DialogResult>>()
    .mockResolvedValue({ cancelled: true, answers: [] });

  const context = { mode: 'tui', ui: { custom } } as unknown as Parameters<
    ToolDefinition['execute']
  >[4];

  const call = async () => {
    const params: Parameters<ToolDefinition['execute']>[1] = validateToolArguments(tool, {
      type: 'toolCall',
      id: 'call',
      name: tool.name,
      arguments: { questions: [question] } as unknown as ToolCall['arguments'],
    });

    return tool.execute('call', params, undefined, undefined, context);
  };

  return { call, custom };
};

const layout = {
  question: 'Which layout should the dashboard use?',
  context: 'The dashboard ships next week. Changing the layout later moves every panel.',
  header: 'Layout',
  options: [
    { label: 'Stacked', description: 'One column. Simple, but wide screens waste space.' },
    { label: 'Split', description: 'Two columns. Uses wide screens, but needs a fallback.' },
  ],
};

const withOptions = (change: Record<string, unknown>[]) => ({
  ...layout,
  options: layout.options.map((option, index) => ({ ...option, ...change[index] })),
});

it('opens the dialog for a valid question', async () => {
  const { call, custom } = ask(
    withOptions([{ recommended: true, preview: 'one' }, { preview: 'two' }]),
  );

  await call();

  expect(custom).toHaveBeenCalledOnce();
});

it.each([
  { rule: 'a missing context', question: { ...layout, context: undefined }, error: /context/u },
  { rule: 'a blank context', question: { ...layout, context: ' \n ' }, error: /context/u },
])('rejects $rule without opening the dialog', async ({ question, error }) => {
  const { call, custom } = ask(question);

  await expect(call()).rejects.toThrow(error);
  expect(custom).not.toHaveBeenCalled();
});
