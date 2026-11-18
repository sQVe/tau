import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import architectExtension from './architect.js';
import { architectLockPath } from './lock.js';

const registerSession = (
  cleanup: (cleanup: () => void) => void,
  role: 'lead' | 'architect' | undefined,
) => {
  vi.stubEnv('TAU_ARCHITECT_ASK', '');
  vi.stubEnv('TAU_ROLE', role);

  cleanup(() => {
    vi.unstubAllEnvs();
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
  { case: 'TAU_ROLE is architect', role: 'architect', tools: [] },
];

for (const { case: description, role, tools } of roleCases) {
  it(`registers the architect tool when ${description}`, ({ onTestFinished }) => {
    const fake = registerSession(onTestFinished, role);

    expect([...fake.tools.keys()]).toEqual(tools);
  });
}
