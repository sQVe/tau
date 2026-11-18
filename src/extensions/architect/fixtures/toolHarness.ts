import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { temporaryTauConfig } from '../../../../tests/tauConfigHarness.js';
import { architectLockPath } from '../lock.js';
import { readArchitectRecord, writeArchitectRecord } from '../record.js';
import type { ArchitectRecord } from '../record.js';

export interface RecordSessionOptions {
  terminal?: string | null;
  mode?: 'visible' | 'ask';
  sessionId?: string;
  token?: string;
}

export const readArchitectOwner = async (root: string): Promise<ArchitectRecord['owner']> => {
  const record = await readArchitectRecord(root);

  return record?.version === 2 ? record.owner : null;
};

export const contextOf = (
  root: string,
  modelRegistry: unknown = {},
  sessionId = 'session-lead',
): ExtensionToolContext =>
  ({
    cwd: root,
    sessionManager: { getSessionId: (): string => sessionId },
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    isProjectTrusted: (): boolean => true,
    modelRegistry,
  }) as unknown as ExtensionToolContext;

const stubEnvironment = (cleanup: (cleanup: () => void) => void, agentDirectory: string): void => {
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  cleanup(() => {
    vi.unstubAllEnvs();
  });
};

export const setup = async (
  cleanup: (cleanup: () => void) => void,
): Promise<{ root: string; config: ReturnType<typeof temporaryTauConfig> }> => {
  const root = await createTemporaryRepository(cleanup);
  const config = temporaryTauConfig(cleanup, 'tau-architect-tool-');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });
  stubEnvironment(cleanup, config.location.agentDirectory);

  return { root, config };
};

export const holdLock = async (root: string, checkout: string, token = 'live'): Promise<void> => {
  const path = `${architectLockPath(root)}.1`;

  await mkdir(dirname(path), { recursive: true });

  await writeFile(
    path,
    JSON.stringify({
      pid: process.pid,
      checkout,
      startedAt: new Date().toISOString(),
      token,
    }),
  );
};

export const recordSession = async (
  root: string,
  options: RecordSessionOptions = {},
): Promise<string> => {
  const {
    terminal = null,
    mode = 'visible',
    sessionId = 'session-architect',
    token = 'live',
  } = options;

  const sessionFile = join(root, 'architect-session.jsonl');

  await writeFile(sessionFile, '');

  await writeArchitectRecord(root, {
    version: 2,
    sessionFile,
    leadTerminal: 't-lead',
    owner: { lockToken: token, mode, terminal, sessionId },
    updatedAt: new Date().toISOString(),
  });

  return sessionFile;
};
