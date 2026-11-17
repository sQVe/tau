import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { createExecFake, succeededResult } from '../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryTauConfig } from '../../../tests/tauConfigHarness.js';
import { askDeadlineSeconds } from './ask.js';
import { gateClassifier } from './gate.js';
import { architectLockPath } from './lock.js';
import {
  askRecordDirectory,
  gateRecordDirectory,
  readAskRecords,
  readArchitectRecord,
  writeArchitectRecord,
} from './record.js';
import { createArchitectTool } from './tool.js';

const classifyAsSpecified = async () => ({
  stopReason: 'stop',
  answers: { choice: { type: 'choice', choice: 'specified', confidence: 0.9 } },
});

const appFake = () =>
  createExecFake<'app'>({
    keyOf: (command) => (command === 'herdr-app' ? 'app' : undefined),
    handlerFor: () => () => succeededResult('{"ok":true}'),
  });

const contextOf = (root: string, modelRegistry: unknown = {}): ExtensionToolContext =>
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

const setup = async (cleanup: (cleanup: () => void) => void) => {
  const root = await createTemporaryRepository(cleanup);
  const config = temporaryTauConfig(cleanup, 'tau-architect-tool-');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });
  stubEnvironment(cleanup, config.location.agentDirectory);

  return { root, config };
};

const holdLock = async (root: string, checkout: string): Promise<void> => {
  const path = `${architectLockPath(root)}.1`;

  await mkdir(dirname(path), { recursive: true });

  await writeFile(
    path,
    JSON.stringify({
      pid: process.pid,
      checkout,
      startedAt: new Date().toISOString(),
      token: 'live',
    }),
  );
};

const recordSession = async (root: string): Promise<string> => {
  const sessionFile = join(root, 'architect-session.jsonl');

  await writeFile(sessionFile, '');

  await writeArchitectRecord(root, {
    version: 1,
    sessionFile,
    terminal: null,
    leadTerminal: 't-lead',
    updatedAt: new Date().toISOString(),
  });

  return sessionFile;
};

it('open refuses while a live holder holds the lock', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const app = appFake();
  const tool = createArchitectTool({ ...hc, exec: app.exec, cwd: root });

  await holdLock(root, '/other/checkout');

  await expect(
    tool.execute('call', { action: 'open' }, undefined, undefined, contextOf(root)),
  ).rejects.toThrow('The architect is already running in /other/checkout.');

  expect(app.calls).toEqual([]);
});

it('open starts a fresh architect on roles.architect.model', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const app = appFake();
  const tool = createArchitectTool({ ...hc, exec: app.exec, cwd: root });
  const design = join(root, '.tau', 'slices', 'me-1', 'design.md');

  await mkdir(dirname(design), { recursive: true });
  await writeFile(design, '# Design\n');

  const result = await tool.execute(
    'call',
    { action: 'open' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toEqual({ action: 'open', status: 'opened', sessionFile: null });

  const [call] = app.calls;
  const args = call?.commandArguments ?? [];
  const serialized = JSON.stringify(args);

  expect(call?.command).toBe('herdr-app');
  expect(args).toContain('space.new');
  expect(args).toContain(`architect-${basename(root)}`);
  expect(serialized).toContain('TAU_ROLE=architect');
  expect(serialized).toContain('TAU_LEAD_TERMINAL=t-lead');
  expect(serialized).toContain('--provider');
  expect(serialized).toContain('--model');
  expect(serialized).toContain('architect');
  expect(serialized).toContain(design);
});

it('open resumes the recorded architect session', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const app = appFake();
  const tool = createArchitectTool({ ...hc, exec: app.exec, cwd: root });
  const sessionFile = await recordSession(root);

  const result = await tool.execute(
    'call',
    { action: 'open' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toEqual({ action: 'open', status: 'resumed', sessionFile });

  const serialized = JSON.stringify(app.calls[0]?.commandArguments ?? []);

  expect(serialized).toContain('--session');
  expect(serialized).toContain(sessionFile);
});

it('open starts a fresh session when the recorded session file is gone', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const app = appFake();
  const tool = createArchitectTool({ ...hc, exec: app.exec, cwd: root });
  const missingSession = join(root, 'missing-session.jsonl');

  await writeArchitectRecord(root, {
    version: 1,
    sessionFile: missingSession,
    terminal: null,
    leadTerminal: 't-lead',
    updatedAt: new Date().toISOString(),
  });

  const result = await tool.execute(
    'call',
    { action: 'open' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toEqual({ action: 'open', status: 'opened', sessionFile: null });

  const serialized = JSON.stringify(app.calls[0]?.commandArguments ?? []);

  expect(serialized).not.toContain('--session');
  expect(serialized).not.toContain(missingSession);
});

it('ask refuses without a recorded session file', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect((result.details as { reason: string }).reason).toContain('architect open');
});

it('ask refuses while the lock is held', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root);
  await holdLock(root, '/other/checkout');

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect((result.details as { reason: string }).reason).toContain('/other/checkout');
});

it('a second ask while one runs is refused', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root);
  await mkdir(askRecordDirectory(root), { recursive: true });

  await writeFile(
    join(askRecordDirectory(root), 'ask-1.json'),
    JSON.stringify({
      version: 1,
      askId: 'ask-1',
      createdAt: new Date().toISOString(),
      question: 'Earlier question',
      sessionFile: join(root, 'architect-session.jsonl'),
      terminal: 't-ask',
      leadTerminal: 't-lead',
      deadline: Date.now() + 1000,
      status: 'running',
      detail: null,
    }),
  );

  hc.reply('get', JSON.stringify({ address: 't-ask', state: 'live' }));

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect((result.details as { reason: string }).reason).toContain('ask-1');
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
});

it('an ask deadline returns needsOpen and kills the terminal', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({ terminal: 't-ask', ended: false, reason: 'timeout', turn: 0, children: [] }),
  );

  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'finished' }));
  const startedAt = Date.now();

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect(hc.calls.some((call) => call.commandArguments[0] === 'kill')).toBe(true);
  const [record] = await readAskRecords(root);

  expect(record).toMatchObject({ status: 'timeout', terminal: 't-ask' });
  expect(record?.deadline).toBeGreaterThanOrEqual(startedAt + askDeadlineSeconds * 1000);
});

it('gate writes one record per call', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  const classifierCalls: unknown[][] = [];

  const context = contextOf(root, {
    findOfType: (...args: unknown[]) => {
      classifierCalls.push(args);

      return {};
    },
    classify: classifyAsSpecified,
  });

  const first = await tool.execute(
    'call',
    { action: 'gate', request: 'Rename --fast.', restatement: 'Rename --fast to --quick.' },
    undefined,
    undefined,
    context,
  );

  const second = await tool.execute(
    'call',
    { action: 'gate', request: 'Rename --fast.', restatement: 'Rename --fast to --quick.' },
    undefined,
    undefined,
    context,
  );

  expect(first.details).toMatchObject({ decision: 'specified', label: 'specified' });
  expect(second.details).toMatchObject({ decision: 'specified', label: 'specified' });
  expect(classifierCalls[0]).toEqual(['classifier', ...gateClassifier.split('/')]);
  expect(await readdir(gateRecordDirectory(root))).toHaveLength(2);
  expect(await readArchitectRecord(root)).toBeUndefined();
});
