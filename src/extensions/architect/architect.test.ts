import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { forgetAcceptCheck } from '../../../tests/inboxReceiverHarness.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import architectExtension from './architect.js';
import { architectLockPath } from './lock.js';
import { writeAskRecord } from './record.js';
import type { LiveAskRecord } from './record.js';

const registerSession = (
  cleanup: (cleanup: () => void) => void,
  role: 'lead' | 'architect' | undefined,
) => {
  vi.stubEnv('TAU_ARCHITECT_ASK', '');
  vi.stubEnv('TAU_ROLE', role);

  cleanup(() => {
    vi.unstubAllEnvs();
    forgetAcceptCheck('architect-ask');
  });

  const fake = fakeExtensionApi();

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

const sessionContext = (cwd: string) => {
  const notify = vi.fn<(message: string, level?: string) => void>();
  const shutdown = vi.fn<() => void>();

  const context = {
    cwd,
    ui: { notify },
    shutdown,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionFile: () => '/sessions/architect.jsonl',
      getSessionId: () => 'session-architect',
    },
  } as unknown as ExtensionContext;

  return { context, notify, shutdown };
};

const runHandlers = async (
  fake: ReturnType<typeof fakeExtensionApi>,
  name: string,
  context: ExtensionContext,
): Promise<void> => {
  for (const handler of fake.handlers.get(name) ?? []) {
    await handler({} as never, context);
  }
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
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  const root = await createTemporaryRepository(onTestFinished);
  const fake = registerSession(onTestFinished, 'architect');
  const { context, shutdown } = sessionContext(root);

  await runHandlers(fake, 'session_start', context);

  const handoverShutdown = receiveHandover(
    fake,
    { status: 'queued' },
    { action: 'send', final: true },
  );

  expect(handoverShutdown).toHaveBeenCalledTimes(1);

  await runHandlers(fake, 'session_shutdown', context);

  expect(shutdown).not.toHaveBeenCalled();
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
    await runHandlers(fake, 'session_shutdown', context);
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
    await runHandlers(fake, 'session_shutdown', context);
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
