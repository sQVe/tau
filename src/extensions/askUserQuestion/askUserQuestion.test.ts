import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { workerNoticeChannel } from '../../workerNoticeEvent.js';
import askUserQuestionExtension from './askUserQuestion.js';
import { actionLabel } from './dialog.js';
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
  const terminal = { terminal: { rows: 24, columns: 60 }, requestRender: () => undefined };

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
      sessionManager: { getBranch: () => [] },
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

const notice = { worker: 'scout-ov', label: 'asks' };
const down = '\u001B[B';
const escape = '\u001B';

const features = {
  question: 'Which features?',
  problem: 'Decides what ships first.',
  impact: 'Changing it later needs a migration.',
  header: 'Features',
  multiSelect: true,
  options: [
    { label: 'Lint', description: 'Checks style.' },
    { label: 'Format', description: 'Fixes style.' },
  ],
};

it('subscribes to worker notices only while the dialog is open', async () => {
  const { events, run, latest } = driver();
  const original = events.on.bind(events);
  const stops: Mock<() => void>[] = [];

  const on = vi.spyOn(events, 'on').mockImplementation((channel, handler) => {
    const stop = vi.fn<() => void>(original(channel, handler));

    stops.push(stop);

    return stop;
  });

  expect(on).not.toHaveBeenCalled();

  const pending = run([layout]);

  expect(on).toHaveBeenCalledTimes(1);
  expect(stops[0]).not.toHaveBeenCalled();

  latest().handleInput(escape);
  await pending;

  expect(stops[0]).toHaveBeenCalledOnce();
});

it('ignores a malformed worker notice event', async () => {
  const { events, run, latest } = driver();
  const pending = run([layout]);
  const before = latest().render(80);

  events.emit(workerNoticeChannel, { worker: 3 });

  const after = latest().render(80);

  latest().handleInput(escape);
  await pending;

  expect(after).toEqual(before);
});

it('returns a deferred result that says nothing was answered', async () => {
  const { events, run, latest } = driver();
  const pending = run([layout]);

  events.emit(workerNoticeChannel, notice);

  for (const key of [down, down, down, '\r']) {
    latest().handleInput(key);
  }

  const result = await pending;

  expect(result.details).toMatchObject({ kind: 'deferred', notices: [notice] });
});

it('restores selections and typed text when the same questions are asked again', async () => {
  const { events, run, latest } = driver();
  const first = run([features]);

  events.emit(workerNoticeChannel, notice);

  for (const key of [' ', down, down, 'h', 'i', down, '\r']) {
    latest().handleInput(key);
  }

  await first;

  const second = run([features]);
  const lines = latest().render(80).join('\n');

  latest().handleInput('\r');

  const result = await second;

  expect(lines).not.toContain(actionLabel([notice]));

  expect(result.details).toEqual({
    kind: 'answered',
    answers: [{ question: 'Which features?', selected: ['Lint', 'hi'], typed: true }],
  });
});

it('restores selections when the same questions come back with reordered properties', async () => {
  const { events, run, latest } = driver();
  const first = run([features]);

  events.emit(workerNoticeChannel, notice);

  for (const key of [' ', down, down, down, '\r']) {
    latest().handleInput(key);
  }

  await first;

  const reordered = {
    options: features.options.map(({ description, label }) => ({ description, label })),
    multiSelect: features.multiSelect,
    header: features.header,
    impact: features.impact,
    problem: features.problem,
    question: features.question,
  };

  const second = run([reordered]);
  const lines = latest().render(80).join('\n');

  latest().handleInput(escape);
  await second;

  expect(lines).toContain('[x] Lint');
});

it('keeps the deferred selections while other questions are asked in between', async () => {
  const { events, run, latest } = driver();
  const first = run([features]);

  events.emit(workerNoticeChannel, notice);

  for (const key of [' ', down, down, down, '\r']) {
    latest().handleInput(key);
  }

  await first;

  const between = run([layout]);

  latest().handleInput(escape);
  await between;

  const again = run([features]);
  const lines = latest().render(80).join('\n');

  latest().handleInput(escape);
  await again;

  expect(lines).toContain('[x] Lint');
});

it('starts fresh for different questions', async () => {
  const { events, run, latest } = driver();
  const first = run([features]);

  events.emit(workerNoticeChannel, notice);

  for (const key of [' ', down, down, down, '\r']) {
    latest().handleInput(key);
  }

  expect(await first).toMatchObject({ details: { kind: 'deferred' } });

  const other = run([{ ...features, question: 'Which checks?' }]);

  // A restored Lint check would let Enter submit.
  latest().handleInput('\r');
  latest().handleInput(escape);

  expect(await other).toMatchObject({ details: { kind: 'declined' } });
});

it('keeps the questionnaire state out of the deferred result', async () => {
  const { events, run, latest } = driver();
  const pending = run([features]);

  events.emit(workerNoticeChannel, notice);

  for (const key of [' ', down, down, 'h', down, '\r']) {
    latest().handleInput(key);
  }

  const result = await pending;

  expect(result.details).toEqual({ kind: 'deferred', notices: [notice] });
});

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
  {
    name: 'deferred result',
    branch: [typedAnswer, toolResult({ kind: 'deferred', notices: [] })],
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

it('gives the model different text for answered, declined, and deferred results', async () => {
  const answeredRun = driver();
  const answeredPending = answeredRun.run([layout]);

  answeredRun.latest().handleInput('\r');

  const declinedRun = driver();
  const declinedPending = declinedRun.run([layout]);

  declinedRun.latest().handleInput(escape);

  const deferredRun = driver();
  const deferredPending = deferredRun.run([layout]);

  deferredRun.events.emit(workerNoticeChannel, notice);

  for (const key of [down, down, down, '\r']) {
    deferredRun.latest().handleInput(key);
  }

  const answeredText = textOf(await answeredPending);
  const declinedText = textOf(await declinedPending);
  const deferredText = textOf(await deferredPending);

  expect(answeredText).toContain('Stacked');
  expect(declinedText).toMatch(/declined/iu);
  expect(declinedText).not.toContain('Stacked');
  expect(deferredText).toMatch(/notice/iu);
  expect(deferredText).not.toContain('Stacked');
  expect(new Set([answeredText, declinedText, deferredText]).size).toBe(3);
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

const deferOnce = async (
  run: (questions: unknown[]) => Promise<unknown>,
  latest: () => OpenDialog,
  events: ReturnType<typeof driver>['events'],
  questions: unknown[],
) => {
  const first = run(questions);

  events.emit(workerNoticeChannel, notice);

  for (const key of [' ', down, down, down, '\r']) {
    latest().handleInput(key);
  }

  await first;
};

// Enter submits only when the earlier check came back, so the result shows what was restored.
const restoredResult = async (change: Record<string, unknown>) => {
  const { events, run, latest } = driver();

  await deferOnce(run, latest, events, [features]);

  const second = run([change]);

  latest().handleInput('\r');
  latest().handleInput(escape);

  return (await second).details;
};

const featureOptions = (change: Record<string, unknown>[]) =>
  features.options.map((option, index) => ({ ...option, ...change[index] }));

it.each([
  { rule: 'the same questions', change: {}, restored: true },
  { rule: 'a question preview', change: { preview: 'draft' }, restored: false },
  {
    rule: 'an option preview',
    change: { options: featureOptions([{ preview: 'sketch' }]) },
    restored: false,
  },
  {
    rule: 'an option description',
    change: { options: featureOptions([{ description: 'Checks more.' }]) },
    restored: false,
  },
  {
    rule: 'a recommendation',
    change: { options: featureOptions([{}, { recommended: true }]) },
    restored: false,
  },
  {
    rule: 'a recommendation on the first option',
    change: { options: featureOptions([{ recommended: true }]) },
    restored: false,
  },
  {
    rule: 'a header',
    change: { header: 'Other' },
    restored: false,
  },
])('restores the deferred selections for $rule: $restored', async ({ change, restored }) => {
  const details = await restoredResult({ ...features, ...change });

  expect(details).toMatchObject({ kind: restored ? 'answered' : 'declined' });
});

it('restores the deferred selections only once', async () => {
  const { events, run, latest } = driver();

  await deferOnce(run, latest, events, [features]);

  const second = run([features]);

  latest().handleInput(escape);
  await second;

  const third = run([features]);

  latest().handleInput('\r');
  latest().handleInput(escape);

  expect((await third).details).toMatchObject({ kind: 'declined' });
});

it('keeps the restored typed text when the user edits the custom row', async () => {
  const { events, run, latest } = driver();
  const first = run([features]);

  events.emit(workerNoticeChannel, notice);

  for (const key of [down, down, 'h', 'i', down, '\r']) {
    latest().handleInput(key);
  }

  await first;

  const second = run([features]);

  latest().handleInput('!');
  latest().handleInput('\r');

  const [typed] = answers(await second);

  expect(typed?.selected[0]).toContain('hi');
  expect(typed?.selected[0]).toContain('!');
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

it.each([
  { limit: 'label of 60', call: limitCall({}, { label: 'x'.repeat(60) }), valid: true },
  { limit: 'label of 61', call: limitCall({}, { label: 'x'.repeat(61) }), valid: false },
  {
    limit: 'description of 220',
    call: limitCall({}, { description: 'x'.repeat(220) }),
    valid: true,
  },
  {
    limit: 'description of 221',
    call: limitCall({}, { description: 'x'.repeat(221) }),
    valid: false,
  },
  { limit: 'problem of 300', call: limitCall({ problem: 'x'.repeat(300) }), valid: true },
  { limit: 'problem of 301', call: limitCall({ problem: 'x'.repeat(301) }), valid: false },
  { limit: 'impact of 200', call: limitCall({ impact: 'x'.repeat(200) }), valid: true },
  { limit: 'impact of 201', call: limitCall({ impact: 'x'.repeat(201) }), valid: false },
  { limit: 'header of 16', call: limitCall({ header: 'x'.repeat(16) }), valid: true },
  { limit: 'header of 17', call: limitCall({ header: 'x'.repeat(17) }), valid: false },
  {
    limit: '4 options',
    call: limitCall({
      options: ['A', 'B', 'C', 'D'].map((label) => ({ label, description: 'a' })),
    }),
    valid: true,
  },
  {
    limit: '5 options',
    call: limitCall({
      options: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label, description: 'a' })),
    }),
    valid: false,
  },
  {
    limit: '1 option',
    call: limitCall({ options: [{ label: 'A', description: 'a' }] }),
    valid: false,
  },
  {
    limit: '4 questions',
    call: {
      questions: Array.from({ length: 4 }, () => limitCall({}).questions[0]),
    },
    valid: true,
  },
  {
    limit: '5 questions',
    call: {
      questions: Array.from({ length: 5 }, () => limitCall({}).questions[0]),
    },
    valid: false,
  },
  { limit: 'no questions', call: { questions: [] }, valid: false },
])('checks the arguments against $limit', ({ call, valid }) => {
  const { tool } = registeredTool();

  expect(Value.Check(tool.parameters, call)).toBe(valid);
});
