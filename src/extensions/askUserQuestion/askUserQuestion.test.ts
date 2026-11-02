import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import askUserQuestionExtension from './askUserQuestion.js';
import type { DialogResult } from './dialog.js';

interface OpenDialog {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
}

const registeredTool = () => {
  const fake = fakeExtensionApi();

  askUserQuestionExtension(fake.pi);

  const tool = fake.tools.get('ask_user_question');

  if (tool === undefined) {
    throw new Error('The extension registered no tool.');
  }

  return { tool, events: fake.pi.events };
};

// Pi checks the schema before it runs the tool, so the call goes through the same check.
const ask = (question: Record<string, unknown>, branch: unknown[] = []) => {
  const { tool } = registeredTool();

  const custom = vi.fn<() => Promise<DialogResult>>().mockResolvedValue({ kind: 'declined' });

  const context = {
    mode: 'tui',
    ui: { custom },
    sessionManager: { getBranch: () => branch },
  } as unknown as Parameters<ToolDefinition['execute']>[4];

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
  problem: 'The dashboard ships next week.',
  impact: 'Changing the layout later moves every panel.',
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
  { rule: 'a missing problem', question: { ...layout, problem: undefined }, error: /problem/u },
  { rule: 'a missing impact', question: { ...layout, impact: undefined }, error: /impact/u },
  { rule: 'a blank problem', question: { ...layout, problem: ' \n ' }, error: /needs a problem/u },
  { rule: 'a blank impact', question: { ...layout, impact: ' ' }, error: /needs an impact/u },
])('rejects $rule without opening the dialog', async ({ question, error }) => {
  const { call, custom } = ask(question);

  await expect(call()).rejects.toThrow(error);
  expect(custom).not.toHaveBeenCalled();
});

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

// Builds the component the way Pi does and hands the test the dialog and its result.
const driver = () => {
  const { tool, events } = registeredTool();
  const dialogs: OpenDialog[] = [];

  const terminal = {
    terminal: { rows: 24, columns: 60, setProgramStatus: () => undefined },
    requestRender: () => undefined,
  };

  const custom = (factory: unknown) =>
    new Promise<DialogResult>((resolve) => {
      const build = factory as (...args: unknown[]) => OpenDialog;

      dialogs.push(build(terminal, theme, undefined, resolve));
    });

  const run = (questions: unknown[]) => {
    const params: Parameters<ToolDefinition['execute']>[1] = validateToolArguments(tool, {
      type: 'toolCall',
      id: 'call',
      name: tool.name,
      arguments: { questions } as unknown as ToolCall['arguments'],
    });

    const context = {
      mode: 'tui',
      ui: { custom },
      sessionManager: { getBranch: () => [], getSessionName: () => undefined },
    } as unknown as Parameters<ToolDefinition['execute']>[4];

    return tool.execute('call', params, undefined, undefined, context);
  };

  const latest = () => {
    const dialog = dialogs.at(-1);

    if (dialog === undefined) {
      throw new Error('No dialog is open.');
    }

    return dialog;
  };

  return { events, run, latest };
};

const down = '\u001B[B';

const askResult = (typed: boolean) => ({
  type: 'message',
  message: {
    role: 'toolResult',
    toolName: 'ask_user_question',
    details: { kind: 'answered', answers: [{ question: 'Q?', selected: ['x'], typed }] },
  },
});

const assistant = (...content: Record<string, unknown>[]) => ({
  type: 'message',
  message: { role: 'assistant', content },
});

it('refuses a new question after a typed answer with no visible reply', async () => {
  const branch = [askResult(true), assistant({ type: 'thinking', thinking: 'Explaining.' })];
  const { call, custom } = ask(layout, branch);

  await expect(call()).rejects.toThrow('visible text');

  expect(custom).not.toHaveBeenCalled();
});

it('allows a new question after a typed answer when the assistant wrote visible text', async () => {
  const branch = [askResult(true), assistant({ type: 'text', text: 'Here are the trade-offs.' })];
  const { call, custom } = ask(layout, branch);

  await call();

  expect(custom).toHaveBeenCalledOnce();
});

it('allows a new question when the last result has no typed answer', async () => {
  const { call, custom } = ask(layout, [askResult(true), askResult(false)]);

  await call();

  expect(custom).toHaveBeenCalledOnce();
});

const toolResult = (details: unknown, toolName = 'ask_user_question') => ({
  type: 'message',
  message: { role: 'toolResult', toolName, details },
});

const answered = (answer: unknown) => toolResult({ kind: 'answered', answers: [answer] });
const typedAnswer = answered({ question: 'Q?', selected: ['x'], typed: true });
const visible = assistant({ type: 'text', text: 'Reply.' });

it.each([
  { name: 'typed result alone', branch: [typedAnswer], refused: true },
  {
    name: 'blank text',
    branch: [typedAnswer, assistant({ type: 'text', text: '  \n' })],
    refused: true,
  },
  {
    name: 'text block without text',
    branch: [typedAnswer, assistant({ type: 'text' })],
    refused: true,
  },
  {
    name: 'tool call only',
    branch: [typedAnswer, assistant({ type: 'toolCall', name: 'ask_user_question' })],
    refused: true,
  },
  {
    name: 'unrelated entry types',
    branch: [typedAnswer, { type: 'label' }, { type: 'custom' }],
    refused: true,
  },
  {
    name: 'unrelated tool result',
    branch: [typedAnswer, toolResult({ typed: false }, 'bash')],
    refused: true,
  },
  {
    name: 'user message',
    branch: [typedAnswer, { type: 'message', message: { role: 'user', content: 'hi' } }],
    refused: true,
  },
  {
    name: 'malformed assistant content',
    branch: [typedAnswer, { type: 'message', message: { role: 'assistant', content: 'text' } }],
    refused: true,
  },
  {
    name: 'refused call after typed result',
    branch: [
      typedAnswer,
      { type: 'message', message: { ...toolResult({}).message, isError: true } },
    ],
    refused: true,
  },
  { name: 'visible text after result', branch: [typedAnswer, visible], refused: false },
  {
    name: 'text beside a tool call',
    branch: [typedAnswer, assistant({ type: 'text', text: 'Reply.' }, { type: 'toolCall' })],
    refused: false,
  },
  {
    name: 'options-only result',
    branch: [answered({ question: 'Q?', selected: ['x'], typed: false })],
    refused: false,
  },
  {
    name: 'typed result superseded by options-only',
    branch: [typedAnswer, answered({ question: 'Q?', selected: ['x'], typed: false })],
    refused: false,
  },
  {
    name: 'declined result',
    branch: [typedAnswer, toolResult({ kind: 'declined' })],
    refused: false,
  },
  { name: 'absent details', branch: [toolResult(undefined)], refused: false },
  {
    name: 'details without typed',
    branch: [answered({ question: 'Q?', selected: ['x'] })],
    refused: false,
  },
  {
    name: 'non-boolean typed',
    branch: [answered({ question: 'Q?', selected: ['x'], typed: 'true' })],
    refused: false,
  },
  { name: 'null details', branch: [toolResult(null)], refused: false },
  { name: 'string details', branch: [toolResult('answered')], refused: false },
  {
    name: 'answers not a list',
    branch: [toolResult({ kind: 'answered', answers: 'typed' })],
    refused: false,
  },
  {
    name: 'null answer',
    branch: [toolResult({ kind: 'answered', answers: [null] })],
    refused: false,
  },
  { name: 'no earlier result', branch: [], refused: false },
])('branch with $name', async ({ branch, refused }) => {
  const { call, custom } = ask(layout, branch);

  const outcome = await call().then(
    () => 'allowed',
    (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
  );

  expect(outcome === 'allowed').toBe(!refused);
  expect(custom).toHaveBeenCalledTimes(refused ? 0 : 1);
});

const answers = (result: { details?: unknown }) =>
  (result.details as { answers: { selected: string[]; typed: boolean }[] }).answers;

const answerWith = async (keys: string[]) => {
  const { run, latest } = driver();
  const pending = run([layout]);

  for (const key of keys) {
    latest().handleInput(key);
  }

  return pending;
};

it('answers a typed answer differently from an options-only answer with the same text', async () => {
  const optionsOnly = await answerWith(['\r']);
  const typed = await answerWith([down, down, ...'Stacked'.split(''), '\r']);

  expect(answers(optionsOnly)).toEqual([
    expect.objectContaining({ selected: ['Stacked'], typed: false }),
  ]);

  expect(answers(typed)).toEqual([expect.objectContaining({ selected: ['Stacked'], typed: true })]);
  expect(typed.content).not.toEqual(optionsOnly.content);
});

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[]).map((item) => item.text).join('\n');

const previewed = {
  ...layout,
  options: [
    { label: 'Stacked', description: 'One column.', preview: 'column-sketch' },
    { label: 'Split', description: 'Two columns.' },
  ],
};

it('tells the model which option the user picked and its preview', async () => {
  const { run, latest } = driver();
  const pending = run([previewed]);

  latest().handleInput('\r');

  const text = textOf(await pending);

  expect(text).toContain(layout.question);
  expect(text).toContain('Stacked');
  expect(text).toContain('column-sketch');
});

it('leaves a preview out of the text when the picked option has none', async () => {
  const { run, latest } = driver();
  const pending = run([previewed]);

  latest().handleInput(down);
  latest().handleInput('\r');

  const text = textOf(await pending);

  expect(text).toContain('Split');
  expect(text).not.toContain('column-sketch');
  expect(text).not.toContain('undefined');
});

it('fails outside the terminal UI so the model asks in plain text', async () => {
  const { tool } = registeredTool();
  const custom = vi.fn<() => Promise<DialogResult>>().mockResolvedValue({ kind: 'declined' });

  const context = {
    mode: 'rpc',
    ui: { custom },
    sessionManager: { getBranch: () => [] },
  } as unknown as Parameters<ToolDefinition['execute']>[4];

  const params = { questions: [layout] } as Parameters<ToolDefinition['execute']>[1];

  await expect(tool.execute('call', params, undefined, undefined, context)).rejects.toThrow(
    'plain text',
  );

  expect(custom).not.toHaveBeenCalled();
});

it('reports a dialog that closes without a result as declined', async () => {
  const { call, custom } = ask(layout);

  custom.mockResolvedValue(undefined as unknown as DialogResult);

  const result = await call();

  expect(result.details).toEqual({ kind: 'declined' });
  expect(textOf(result)).toMatch(/declined/iu);
});

it('treats a question without multiSelect as single-select', async () => {
  const { run, latest } = driver();
  const pending = run([layout]);

  latest().handleInput(' ');
  latest().handleInput('\r');

  expect(answers(await pending)).toEqual([expect.objectContaining({ selected: ['Stacked'] })]);
});

const limitCall = (change: Record<string, unknown>, optionChange: Record<string, unknown> = {}) => {
  const option = { label: 'A', description: 'a', ...optionChange };

  return {
    questions: [
      {
        question: 'Q?',
        problem: 'P',
        impact: 'I',
        header: 'H',
        options: [option, { ...option, label: 'B' }],
        ...change,
      },
    ],
  };
};

it('accepts a call of ordinary size', () => {
  const { tool } = registeredTool();

  expect(Value.Check(tool.parameters, limitCall({}))).toBe(true);
});

const long = 'x'.repeat(1000);

const manyOptions = Array.from({ length: 20 }, (_, index) => ({
  label: `Option ${index}`,
  description: 'a',
}));

it.each([
  { limit: 'a very long label', call: limitCall({}, { label: long }) },
  { limit: 'a very long description', call: limitCall({}, { description: long }) },
  { limit: 'a very long problem', call: limitCall({ problem: long }) },
  { limit: 'a very long impact', call: limitCall({ impact: long }) },
  { limit: 'a very long header', call: limitCall({ header: long }) },
  { limit: 'many options', call: limitCall({ options: manyOptions }) },
  { limit: 'no options', call: limitCall({ options: [] }) },
  {
    limit: 'many questions',
    call: { questions: Array.from({ length: 20 }, () => limitCall({}).questions[0]) },
  },
  { limit: 'no questions', call: { questions: [] } },
])('refuses $limit', ({ call }) => {
  const { tool } = registeredTool();

  expect(Value.Check(tool.parameters, call)).toBe(false);
});

const responseAfter = async (typedFlags: boolean[]) => {
  const { call, custom } = ask(layout);

  custom.mockResolvedValue({
    kind: 'answered',
    answers: typedFlags.map((typed, index) => ({ question: `Q${index}?`, selected: ['a'], typed })),
  });

  return textOf(await call());
};

it('responds as for typed answers when only some answers are typed', async () => {
  const allTyped = await responseAfter([true, true]);

  expect(await responseAfter([false, false])).not.toBe(allTyped);
  expect(await responseAfter([false, true])).toBe(allTyped);
  expect(await responseAfter([true, false])).toBe(allTyped);
});
