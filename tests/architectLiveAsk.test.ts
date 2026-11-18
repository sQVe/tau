import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { architectLockPath } from '../src/extensions/architect/lock.js';
import { writeArchitectRecord } from '../src/extensions/architect/record.js';
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

const contextOf = (root: string): ExtensionToolContext =>
  ({
    cwd: root,
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    isProjectTrusted: () => true,
    modelRegistry: {},
  }) as unknown as ExtensionToolContext;

const recordLiveArchitect = async (root: string): Promise<void> => {
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
    version: 1,
    sessionFile,
    terminal: 't-architect',
    leadTerminal: 't-lead',
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

  await recordLiveArchitect(root);
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

  expect(question).toContain('handover send');

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
