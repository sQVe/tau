import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { workerNoticeChannel } from '../../workerNoticeEvent.js';
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
const ask = (question: Record<string, unknown>) => {
  const { tool } = registeredTool();

  const custom = vi.fn<() => Promise<DialogResult>>().mockResolvedValue({ kind: 'declined' });

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

    const context = { mode: 'tui', ui: { custom } } as unknown as Parameters<
      ToolDefinition['execute']
    >[4];

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
  context: 'Decides what ships first. Changing it later needs a migration.',
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

  events.emit(workerNoticeChannel, { worker: 3 });

  const lines = latest().render(80).join('\n');

  latest().handleInput(escape);
  await pending;

  expect(lines).not.toContain('Handle the');
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

  expect(lines).not.toContain('Handle the');

  expect(result.details).toEqual({
    kind: 'answered',
    answers: [{ question: 'Which features?', selected: ['Lint', 'hi'] }],
  });
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
