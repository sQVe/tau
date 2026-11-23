import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';
import type { Mock } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { createAnswerTracker } from '../answer.js';
import { createAskAdmissions } from '../ask/askAcceptance.js';
import { createHeldLockToken, startArchitectSession } from '../session.js';
import type { ArchitectSession, EndArchitectOptions } from '../session.js';

interface SessionContext {
  context: ExtensionContext;
  notify: Mock<(message: string, level?: string) => void>;
  shutdown: Mock<() => void>;
}

export const hcRuntime = (hc: HcFake): HcRuntime => ({ ...hc, cwd: process.cwd() });

export const endOptions = (): EndArchitectOptions => ({
  answers: createAnswerTracker(),
  admissions: createAskAdmissions(() => undefined),
  sendEndNote: true,
});

export const sessionContext = (cwd: string): SessionContext => {
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

export const stubArchitect = (cleanup: (cleanup: () => void) => void): void => {
  vi.stubEnv('TAU_ROLE', 'architect');
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  cleanup(() => {
    vi.unstubAllEnvs();
  });
};

export const visibleArchitect = async (
  cleanup: (cleanup: () => void) => void,
): Promise<{ root: string; session: ArchitectSession }> => {
  stubArchitect(cleanup);

  const root = await createTemporaryRepository(cleanup);
  const { context } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  if (session === undefined) {
    throw new Error('The architect did not start.');
  }

  return { root, session };
};
