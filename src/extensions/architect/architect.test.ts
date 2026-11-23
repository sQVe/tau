import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { Mock, onTestFinished } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { forgetAcceptCheck, savedTexts } from '../../../tests/inboxReceiverHarness.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import architectExtension from './architect.js';
import { startLeadInbox } from './fixtures/leadInbox.js';
import { sessionContext } from './fixtures/visibleSession.js';
import { architectLockPath } from './lock.js';
import { writeAskRecord, readAskRecord } from './record.js';
import type { LiveAskRecord } from './record.js';

const registerSession = (
  cleanup: (cleanup: () => void) => void,
  role: 'lead' | 'architect' | undefined,
  overrides: Parameters<typeof fakeExtensionApi>[0] = {},
) => {
  vi.stubEnv('TAU_ARCHITECT_ASK', '');
  vi.stubEnv('TAU_ROLE', role);

  cleanup(() => {
    vi.unstubAllEnvs();
    forgetAcceptCheck('architect-ask');
  });

  const fake = fakeExtensionApi(overrides);

  architectExtension(fake.pi);

  return fake;
};

const receiveHandover = (
  fake: ReturnType<typeof fakeExtensionApi>,
  details: Record<string, unknown>,
  input?: Record<string, unknown>,
): Mock<() => void> => {
  const shutdown = vi.fn<() => void>();
  const context = { shutdown } as unknown as ExtensionContext;

  for (const handler of fake.handlers.get('tool_result') ?? []) {
    handler({ toolName: 'handover', details, input } as never, context);
  }

  return shutdown;
};

const runHandlers = async (
  fake: ReturnType<typeof fakeExtensionApi>,
  name: string,
  context: ExtensionContext,
  event: Record<string, unknown> = {},
): Promise<void> => {
  for (const handler of fake.handlers.get(name) ?? []) {
    await handler({ type: name, ...event } as never, context);
  }
};

const startRegisteredArchitect = async (cleanup: typeof onTestFinished) => {
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const root = await createTemporaryRepository(cleanup);
  const hc = createHcFake();
  const lead = await startLeadInbox(cleanup, hc);
  const fake = registerSession(cleanup, 'architect', { exec: hc.exec });
  const { context, shutdown } = sessionContext(root);

  await runHandlers(fake, 'session_start', context);

  return { root, hc, lead, fake, context, shutdown };
};

it('a visible architect stays open after a queued handover that is not final', ({
  onTestFinished,
}) => {
  const fake = registerSession(onTestFinished, 'architect');
  const shutdown = receiveHandover(fake, { status: 'queued' }, { action: 'send' });

  expect(shutdown).not.toHaveBeenCalled();
});

it('a visible architect shuts down and releases its lock after the final handover', async ({
  onTestFinished,
}) => {
  const { root, lead, fake, context, shutdown } = await startRegisteredArchitect(onTestFinished);

  const handoverShutdown = receiveHandover(
    fake,
    { status: 'queued', terminal: 't-lead' },
    { action: 'send', final: true },
  );

  expect(handoverShutdown).toHaveBeenCalledTimes(1);

  await runHandlers(fake, 'session_shutdown', context, { reason: 'quit' });

  const savedRecords = lead.savedRecords().filter((name) => name.endsWith('.json'));

  expect(shutdown).not.toHaveBeenCalled();
  expect(savedRecords).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('a visible architect stays open after a handover with another status', ({ onTestFinished }) => {
  const fake = registerSession(onTestFinished, 'architect');
  const shutdown = receiveHandover(fake, { status: 'unknown' }, { action: 'send', final: true });

  expect(shutdown).not.toHaveBeenCalled();
});

it('a lead session does not shut down after a queued handover', ({ onTestFinished }) => {
  const fake = registerSession(onTestFinished, 'lead');
  const shutdown = receiveHandover(fake, { status: 'queued' }, { action: 'send', final: true });

  expect(shutdown).not.toHaveBeenCalled();
});

it('a visible architect shuts down but still notes its end after a final handover to another terminal', async ({
  onTestFinished,
}) => {
  const { root, lead, fake, context } = await startRegisteredArchitect(onTestFinished);

  const handoverShutdown = receiveHandover(
    fake,
    { status: 'queued', terminal: 't-other' },
    { action: 'send', final: true },
  );

  expect(handoverShutdown).toHaveBeenCalledTimes(1);

  await runHandlers(fake, 'session_shutdown', context, { reason: 'quit' });

  const savedRecords = lead.savedRecords().filter((name) => name.endsWith('.json'));
  const [text = ''] = await savedTexts(lead);

  expect(savedRecords).toHaveLength(1);
  expect(text).toContain('ended without a final handover');
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('a visible architect sends nothing for a handover result without a final status', async ({
  onTestFinished,
}) => {
  const { lead, fake, context } = await startRegisteredArchitect(onTestFinished);

  const handoverShutdown = receiveHandover(
    fake,
    { status: 'queued', terminal: 't-lead' },
    { action: 'send' },
  );

  expect(handoverShutdown).not.toHaveBeenCalled();
  expect(lead.savedRecords()).toEqual([]);

  await runHandlers(fake, 'session_shutdown', context, { reason: 'quit' });

  const savedRecords = lead.savedRecords().filter((name) => name.endsWith('.json'));

  expect(savedRecords).toHaveLength(1);
});

it('a visible architect sends no end note on reload but still releases its lock and fails open asks', async ({
  onTestFinished,
}) => {
  const { root, lead, fake, context } = await startRegisteredArchitect(onTestFinished);

  await writeAskRecord(root, openAsk);

  await runHandlers(fake, 'session_shutdown', context, { reason: 'reload' });

  const savedRecords = lead.savedRecords().filter((name) => name.endsWith('.json'));
  const [text = ''] = await savedTexts(lead);

  expect(savedRecords).toHaveLength(1);
  expect(text).toContain(`Ask ${openAsk.askId} got no answer`);
  expect(text).toContain('Call architect ask again.');
  expect(await readAskRecord(root, openAsk.askId)).toMatchObject({ status: 'failed' });
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('a visible architect that quit after an unknown final handover tells the lead it may not have arrived', async ({
  onTestFinished,
}) => {
  const { lead, fake, context } = await startRegisteredArchitect(onTestFinished);

  const handoverShutdown = receiveHandover(
    fake,
    { status: 'unknown', terminal: 't-lead' },
    { action: 'send', final: true },
  );

  expect(handoverShutdown).not.toHaveBeenCalled();

  await runHandlers(fake, 'session_shutdown', context, { reason: 'quit' });

  const names = lead.savedRecords().filter((name) => name.endsWith('.json'));
  const [text = ''] = await savedTexts(lead);

  expect(names).toHaveLength(1);
  expect(text).toContain('returned unknown');
  expect(text).toContain('may not have reached you');
});

const roleCases: readonly {
  case: string;
  role: 'lead' | 'architect' | undefined;
  tools: string[];
}[] = [
  { case: 'TAU_ROLE is unset', role: undefined, tools: ['architect'] },
  { case: 'TAU_ROLE is lead', role: 'lead', tools: ['architect'] },
  { case: 'TAU_ROLE is architect', role: 'architect', tools: ['architect'] },
];

for (const { case: description, role, tools } of roleCases) {
  it(`registers the architect tool when ${description}`, ({ onTestFinished }) => {
    const fake = registerSession(onTestFinished, role);

    expect([...fake.tools.keys()]).toEqual(tools);
  });
}

const openAsk: LiveAskRecord = {
  version: 2,
  route: 'live',
  askId: '0190c1d2-0000-7000-8000-000000000107',
  createdAt: '2026-11-18T10:00:00.000Z',
  question: 'Which flag name?',
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  architectTerminal: 't-architect',
  architectSessionId: 'session-architect',
  architectLockToken: 'live',
  status: 'queued',
  detail: null,
  answer: null,
};

const callHandover = async (
  fake: ReturnType<typeof fakeExtensionApi>,
  input: Record<string, unknown>,
  context: ExtensionContext,
): Promise<unknown[]> => {
  const results: unknown[] = [];

  for (const handler of fake.handlers.get('tool_call') ?? []) {
    results.push(await handler({ toolName: 'handover', input } as never, context));
  }

  return results;
};

it('a visible architect blocks a final handover while an ask to it is open', async ({
  onTestFinished,
}) => {
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  const root = await createTemporaryRepository(onTestFinished);
  const fake = registerSession(onTestFinished, 'architect');
  const { context } = sessionContext(root);
  const send = { action: 'send', terminal: 't-lead', file: 'note.md' };

  await runHandlers(fake, 'session_start', context);
  await writeAskRecord(root, openAsk);

  onTestFinished(async () => {
    await runHandlers(fake, 'session_shutdown', context, { reason: 'quit' });
  });

  const [blocked] = await callHandover(fake, { ...send, final: true }, context);

  expect(blocked).toMatchObject({ block: true });

  expect((blocked as { reason: string }).reason).toContain(
    'ask 0190c1d2-0000-7000-8000-000000000107: "Which flag name?"',
  );

  expect((blocked as { reason: string }).reason).toContain('architect answer');
  await expect(callHandover(fake, send, context)).resolves.toEqual([undefined]);

  await writeAskRecord(root, { ...openAsk, status: 'answered' });

  await expect(callHandover(fake, { ...send, final: true }, context)).resolves.toEqual([undefined]);
});

it('only a visible architect registers the architect answer tool', ({ onTestFinished }) => {
  const architect = registerSession(onTestFinished, 'architect');
  const lead = registerSession(onTestFinished, 'lead');

  expect(architect.tools.get('architect')?.parameters).toMatchObject({
    properties: { action: { const: 'answer' } },
  });

  expect(lead.tools.get('architect')?.parameters).not.toMatchObject({
    properties: { action: { const: 'answer' } },
  });
});

it('the registered lead tool runs a lead action', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  const root = await createTemporaryRepository(onTestFinished);
  const fake = registerSession(onTestFinished, 'lead');
  const tool = fake.tools.get('architect');

  if (tool === undefined) {
    throw new Error('The lead registered no architect tool.');
  }

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    {
      cwd: root,
      ui: { notify: vi.fn<(message: string) => void>() },
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => 'session-lead' },
    } as never,
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
});

it('a non-final tool call is not blocked by a broken ask folder', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  const root = await createTemporaryRepository(onTestFinished);
  const fake = registerSession(onTestFinished, 'architect');
  const { context } = sessionContext(root);

  await runHandlers(fake, 'session_start', context);

  onTestFinished(async () => {
    await runHandlers(fake, 'session_shutdown', context, { reason: 'quit' });
  });

  await mkdir(join(root, '.tau', 'lead'), { recursive: true });
  await writeFile(join(root, '.tau', 'lead', 'ask'), 'not a directory');

  onTestFinished(async () => {
    await rm(join(root, '.tau', 'lead', 'ask'), { force: true });
  });

  await expect(
    callHandover(fake, { action: 'send', terminal: 't-lead' }, context),
  ).resolves.toEqual([undefined]);
});
