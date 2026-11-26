import type {
  AgentBeforeSettleEvent,
  CustomMessageEntryDraft,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { permissionQuestionText } from './fixtures/handBackTexts.js';
import { registerHandBackReminder } from './handBackReminder.js';

type ContextMessage = AgentBeforeSettleEvent['context']['contextMessages'][number];

const context = {} as ExtensionContext;

const userMessage = (text: string): ContextMessage => ({
  role: 'user',
  content: text,
  timestamp: 0,
});

const assistantMessage = (text: string): ContextMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'faux',
  provider: 'faux',
  model: 'faux/test',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 0,
});

const eventFor = (
  contextMessages: AgentBeforeSettleEvent['context']['contextMessages'],
  entries: AgentBeforeSettleEvent['entries'] = [],
): AgentBeforeSettleEvent =>
  ({
    type: 'agent_before_settle',
    entries,
    continue: false,
    outcome: 'completed',
    context: {
      contextEntries: [],
      contextMessages,
      llmMessages: [],
      pendingMessages: [],
      canContinue: true,
    },
  }) satisfies AgentBeforeSettleEvent;

const event = (text: string): AgentBeforeSettleEvent =>
  eventFor([userMessage('Do the work.'), assistantMessage(text)]);

const existingDraft = {
  type: 'custom_message',
  customType: 'existing-draft',
  content: 'Keep me.',
  display: true,
} satisfies CustomMessageEntryDraft;

const setup = () => {
  vi.stubEnv('TAU_ROLE', 'lead');
  const api = fakeExtensionApi();
  registerHandBackReminder(api.pi);

  return api;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

it('appends one reminder and continues for a lead hand-back', () => {
  const api = setup();
  const result = api.handler('agent_before_settle')(event(permissionQuestionText), context);

  expect(result).toMatchObject({
    continue: true,
    entries: [{ type: 'custom_message', customType: 'tau-lead-hand-back-reminder', display: true }],
  });
});

it('settles without entries when the final text is not a hand-back', () => {
  const api = setup();

  const result = api.handler('agent_before_settle')(
    event('Implemented the change and ran the focused tests. All pass.'),
    context,
  );

  expect(result).toBeUndefined();
});

it('settles when the run has no assistant message', () => {
  const api = setup();

  const result = api.handler('agent_before_settle')(
    eventFor([userMessage('Do the work.')]),
    context,
  );

  expect(result).toBeUndefined();
});

it('uses the latest assistant message', () => {
  const api = setup();

  const result = api.handler('agent_before_settle')(
    eventFor([
      userMessage('Do the work.'),
      assistantMessage(permissionQuestionText),
      assistantMessage('Implemented the change and ran the focused tests. All pass.'),
    ]),
    context,
  );

  expect(result).toBeUndefined();
});

it('keeps incoming drafts when it appends the reminder', () => {
  const api = setup();

  const result = api.handler('agent_before_settle')(
    eventFor(
      [userMessage('Do the work.'), assistantMessage(permissionQuestionText)],
      [existingDraft],
    ),
    context,
  );

  expect(result).toMatchObject({
    continue: true,
    entries: [
      existingDraft,
      { type: 'custom_message', customType: 'tau-lead-hand-back-reminder', display: true },
    ],
  });
});

it('does not remind twice in the same user message', () => {
  const api = setup();
  const settle = api.handler('agent_before_settle');

  expect(settle(event(permissionQuestionText), context)).toMatchObject({ continue: true });
  expect(settle(event(permissionQuestionText), context)).toBeUndefined();
});

it('resets after a new user message', () => {
  const api = setup();
  const settle = api.handler('agent_before_settle');
  const messageStart = api.handler('message_start');

  settle(event(permissionQuestionText), context);
  messageStart({ type: 'message_start', message: { role: 'user', content: 'Next.' } }, context);

  expect(settle(event(permissionQuestionText), context)).toMatchObject({ continue: true });
});

it('keeps the reminder spent when a non-user message starts', () => {
  const api = setup();
  const settle = api.handler('agent_before_settle');
  const messageStart = api.handler('message_start');

  settle(event(permissionQuestionText), context);
  messageStart({ type: 'message_start', message: { role: 'assistant', content: [] } }, context);

  expect(settle(event(permissionQuestionText), context)).toBeUndefined();
});
