import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';

import { architectLockPath } from '../src/extensions/architect/lock.js';
import { writeArchitectRecord } from '../src/extensions/architect/record.js';
import { createTemporaryRepository } from './gitRepository.js';
import { temporaryTauConfig } from './tauConfigHarness.js';

export const contextOf = (root: string, modelRegistry: unknown = {}): ExtensionToolContext =>
  ({
    cwd: root,
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    isProjectTrusted: () => true,
    modelRegistry,
  }) as unknown as ExtensionToolContext;

const stubEnvironment = (cleanup: (cleanup: () => void) => void, agentDirectory: string): void => {
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  cleanup(() => {
    vi.unstubAllEnvs();
  });
};

export const setup = async (cleanup: (cleanup: () => void) => void): Promise<{ root: string }> => {
  const root = await createTemporaryRepository(cleanup);
  const config = temporaryTauConfig(cleanup, 'tau-architect-tool-');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });
  stubEnvironment(cleanup, config.location.agentDirectory);

  return { root };
};

const heldLockPath = (root: string): string => `${architectLockPath(root)}.1`;

export const holdLock = async (root: string, checkout: string, token = 'live'): Promise<void> => {
  const path = heldLockPath(root);

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

export const releaseLock = (root: string): Promise<void> => rm(heldLockPath(root));

export const recordSession = async (
  root: string,
  terminal: string | null = null,
): Promise<string> => {
  const sessionFile = join(root, 'architect-session.jsonl');

  await writeFile(sessionFile, '');

  await writeArchitectRecord(root, {
    version: 2,
    sessionFile,
    leadTerminal: 't-lead',
    owner: { lockToken: 'live', mode: 'visible', terminal, sessionId: 'session-architect' },
    updatedAt: new Date().toISOString(),
  });

  return sessionFile;
};
