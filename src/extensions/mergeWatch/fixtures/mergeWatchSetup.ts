import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { onTestFinished } from 'vitest';

import { createExecFake, succeededResult } from '../../../../tests/execFake.js';
import type { ExecCall, ExecHandler, ExecResult } from '../../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../../tests/extensionApi.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import mergeWatchExtension from '../mergeWatch.js';

export type Key = 'resolve' | 'state' | 'checks' | 'merged';

export interface SetupOptions {
  idle?: boolean;
}

export interface MergeWatchSetup {
  fake: ReturnType<typeof fakeExtensionApi>;
  handlers: Record<Key, ExecHandler>;
  execFake: ReturnType<typeof createExecFake<Key>>;
  emit: (name: string, event: unknown) => Promise<void>;
  runBash: (command: string, isError?: boolean) => Promise<void>;
  polls: () => ExecCall[];
  nextDelivery: () => Promise<void>;
  sessionDirectory: string;
  writeTranscript: (lines: readonly string[]) => void;
}

export const url = 'https://github.com/owner/repo/pull/7';
export const minute = 60_000;
export const hours = 60 * minute;

export const stateOutput = (state: string, mergedAt: string | null = null): ExecResult =>
  succeededResult(JSON.stringify({ state, mergedAt }));

export const checksOutput = (checks: { name: string; bucket: string }[], code = 8): ExecResult => ({
  code,
  killed: false,
  truncated: false,
  stdout: JSON.stringify(checks.map((check) => ({ ...check, state: check.bucket }))),
  stderr: '',
});

export const pending = checksOutput([{ name: 'test', bucket: 'pending' }]);
const open = stateOutput('OPEN');
export const merged = stateOutput('MERGED', '2026-10-27T10:00:00Z');

export const resolvedOutput = (
  autoMergeRequest: { mergeMethod: string } | null,
  state = 'OPEN',
): ExecResult => succeededResult(JSON.stringify({ url, state, autoMergeRequest }));

export const autoMergeOn = resolvedOutput({ mergeMethod: 'SQUASH' });
export const autoMergeOff = resolvedOutput(null);

const mergedPullRequestOutput = (
  number = 7,
  headRefName = 'me-7-change',
  createdAt = '2026-11-01T00:00:00.000Z',
  mergedAt = '2026-11-02T00:00:00.000Z',
): ExecResult => succeededResult(JSON.stringify({ number, headRefName, createdAt, mergedAt }));

export const keyOf = (_command: string, commandArguments: readonly string[]): Key | undefined => {
  if (commandArguments[1] === 'checks') {
    return 'checks';
  }

  if (commandArguments.includes('number,headRefName,createdAt,mergedAt')) {
    return 'merged';
  }

  return commandArguments.includes('state,mergedAt') ? 'state' : 'resolve';
};

export const setup = (options: SetupOptions = {}): MergeWatchSetup => {
  const handlers: Record<Key, ExecHandler> = {
    resolve: () => autoMergeOn,
    state: () => open,
    checks: () => pending,
    merged: () => mergedPullRequestOutput(),
  };

  const execFake = createExecFake<Key>({ keyOf, handlerFor: (key) => handlers[key] });
  const fake = fakeExtensionApi({ exec: execFake.exec });
  const idle = options.idle ?? true;
  const sessionDirectory = join(temporaryDirectory(onTestFinished, 'tau-merge-watch-'), 'sessions');

  const deliveryWaiters: (() => void)[] = [];

  fake.sendMessage.mockImplementation(() => {
    deliveryWaiters.shift()?.();
  });

  const nextDelivery = () =>
    new Promise<void>((resolve) => {
      deliveryWaiters.push(resolve);
    });

  const context = {
    cwd: '/repository',
    isIdle: () => idle,
    signal: idle ? undefined : new AbortController().signal,
    sessionManager: { getSessionDir: () => sessionDirectory },
  } as unknown as ExtensionContext;

  mergeWatchExtension(fake.pi);

  const emit = async (name: string, event: unknown) => {
    for (const handler of fake.handlers.get(name) ?? []) {
      await handler(event as never, context);
    }
  };

  const runBash = (command: string, isError = false) =>
    emit('tool_result', { toolName: 'bash', input: { command }, content: [], isError });

  const polls = () =>
    execFake.calls.filter((call) => keyOf('gh', call.commandArguments) === 'state');

  const writeTranscript = (lines: readonly string[]) => {
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(join(sessionDirectory, 'main.jsonl'), lines.join('\n'));
  };

  return {
    fake,
    handlers,
    execFake,
    emit,
    runBash,
    polls,
    nextDelivery,
    sessionDirectory,
    writeTranscript,
  };
};
