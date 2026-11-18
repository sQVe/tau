import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { architectLockPath } from '../src/extensions/architect/lock.js';
import {
  askRecordDirectory,
  readAskRecords,
  writeArchitectRecord,
} from '../src/extensions/architect/record.js';
import { createArchitectTool } from '../src/extensions/architect/tool.js';
import { sendHandover } from '../src/extensions/handover/send.js';
import { createTemporaryRepository } from './gitRepository.js';
import { createHcFake } from './hcFake.js';
import type { HcFake } from './hcFake.js';
import { startHandoverReceiver } from './inboxReceiverHarness.js';
import type { HandoverReceiver } from './inboxReceiverHarness.js';
import { temporaryTauConfig } from './tauConfigHarness.js';

const socketRoot = (): string => {
  const root = mkdtempSync('/tmp/tau-live-ask-');

  chmodSync(root, 0o700);

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return root;
};

const startSilentInbox = async (): Promise<string> => {
  const path = join(socketRoot(), 'silent.sock');
  const server = createServer((socket) => socket.end());

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  return path;
};

const contextOf = (root: string): ExtensionToolContext =>
  ({
    cwd: root,
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    isProjectTrusted: () => true,
    modelRegistry: {},
  }) as unknown as ExtensionToolContext;

const recordLiveArchitect = async (
  root: string,
  architectSessionId = 'session-architect',
): Promise<void> => {
  const lockPath = `${architectLockPath(root)}.1`;
  const sessionFile = join(root, 'architect-session.jsonl');

  await mkdir(dirname(lockPath), { recursive: true });

  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      checkout: root,
      startedAt: new Date().toISOString(),
      token: 'live',
    }),
  );

  await writeFile(sessionFile, '');

  await writeArchitectRecord(root, {
    version: 2,
    sessionFile,
    leadTerminal: 't-lead',
    owner: {
      lockToken: 'live',
      mode: 'visible',
      terminal: 't-architect',
      sessionId: architectSessionId,
    },
    updatedAt: new Date().toISOString(),
  });
};

const replyTerminal = (hc: HcFake, address: string, receiver: HandoverReceiver): void => {
  hc.reply(
    'get',
    JSON.stringify({
      address,
      name: null,
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${receiver.path}` },
    }),
  );
};

const savedText = async (
  sockets: string,
  receiver: HandoverReceiver,
  messageId: string,
): Promise<string> => {
  const saved = await readFile(
    join(sockets, 'records', receiver.sessionId, `${messageId}.json`),
    'utf8',
  );

  return (JSON.parse(saved) as { payload: { text: string } }).payload.text;
};

it('the lead receives the answer of a live architect in its inbox', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const config = temporaryTauConfig(onTestFinished, 'tau-architect-live-ask-');
  const hc = createHcFake();
  const architectSockets = socketRoot();
  const leadSockets = socketRoot();
  const architect = await startHandoverReceiver(onTestFinished, architectSockets, 't-architect');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });
  vi.stubEnv('PI_CODING_AGENT_DIR', config.location.agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await recordLiveArchitect(root, architect.sessionId);
  replyTerminal(hc, 't-architect', architect);

  const asked = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const { messageId } = asked.details as { messageId: string };
  const question = await savedText(architectSockets, architect, messageId);
  const answerFile = join(root, '.tau', 'handovers', 'answer.md');

  expect(asked.details).toMatchObject({
    action: 'ask',
    status: 'queued',
    terminal: 't-architect',
  });

  expect(question).toContain('Which flag name?');
  expect(question).toContain('t-lead');
  expect(question).toContain('handover send');
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');

  await mkdir(dirname(answerFile), { recursive: true });
  await writeFile(answerFile, 'Use --dry-run.\n');
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');
  // One process holds one inbox, so the lead inbox starts after the architect inbox closes.
  const lead = await startHandoverReceiver(onTestFinished, leadSockets, 't-lead');

  replyTerminal(hc, 't-lead', lead);

  const answered = await sendHandover(
    { exec: hc.exec, connect: hc.connect, cwd: root },
    { cwd: root, terminal: 't-lead', file: answerFile },
  );

  expect(answered).toMatchObject({ status: 'queued', terminal: 't-lead' });
  await expect(savedText(leadSockets, lead, answered.messageId)).resolves.toBe('Use --dry-run.\n');
});

it('a second ask refuses while a hidden ask runs, even with this checkout holding the lock', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const config = temporaryTauConfig(onTestFinished, 'tau-architect-hidden-ask-');
  const hc = createHcFake();
  const sockets = socketRoot();
  const receiver = await startHandoverReceiver(onTestFinished, sockets, 't-ask');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });
  vi.stubEnv('PI_CODING_AGENT_DIR', config.location.agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await recordLiveArchitect(root);
  await mkdir(askRecordDirectory(root), { recursive: true });

  await writeFile(
    join(askRecordDirectory(root), 'ask-1.json'),
    JSON.stringify({
      version: 2,
      route: 'hidden',
      askId: 'ask-1',
      createdAt: new Date().toISOString(),
      question: 'Earlier question',
      sessionFile: join(root, 'architect-session.jsonl'),
      terminal: 't-ask',
      leadTerminal: 't-lead',
      deadline: Date.now() + 1000,
      status: 'running',
      detail: null,
      answer: null,
    }),
  );

  replyTerminal(hc, 't-ask', receiver);

  const asked = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const reason = (asked.details as { reason: string }).reason;

  expect(asked.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect(reason).toContain('ask-1');
  expect(reason).toContain('Wait for it');
  expect(reason).not.toContain('architect open');

  await expect(readAskRecords(root)).resolves.toMatchObject({
    records: [{ askId: 'ask-1', status: 'running' }],
  });

  expect(receiver.savedRecords()).toEqual([]);
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
});

it('ask refuses a changed architect session', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const config = temporaryTauConfig(onTestFinished, 'tau-architect-changed-session-');
  const hc = createHcFake();
  const sockets = socketRoot();
  const architect = await startHandoverReceiver(onTestFinished, sockets, 't-architect');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });
  vi.stubEnv('PI_CODING_AGENT_DIR', config.location.agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await recordLiveArchitect(root, 'recorded-session');
  replyTerminal(hc, 't-architect', architect);

  await expect(
    createArchitectTool({ ...hc, cwd: root }).execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    ),
  ).rejects.toThrow(/changed session/);

  expect(architect.savedRecords()).toEqual([]);
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
});

it('an unknown inbox delivery keeps the message ID and asks the lead to wait', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const config = temporaryTauConfig(onTestFinished, 'tau-architect-unknown-ask-');
  const hc = createHcFake();
  const silent = await startSilentInbox();

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });
  vi.stubEnv('PI_CODING_AGENT_DIR', config.location.agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await recordLiveArchitect(root, 'silent');

  hc.reply(
    'get',
    JSON.stringify({
      address: 't-architect',
      name: null,
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${silent}` },
    }),
  );

  const asked = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const details = asked.details as { status: string; messageId: string; note: string };

  expect(details).toMatchObject({
    action: 'ask',
    status: 'unknown',
    terminal: 't-architect',
    sessionId: 'silent',
  });

  expect(details.messageId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  expect(details.note).toContain('may already be in the inbox');
  expect(details.note).toContain('do not ask the same question again');
});
