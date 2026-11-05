import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../command.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import type { Assignment, SavedQuestion } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { createWorkerDelivery, readWorkerChildren } from './workerDelivery.js';

type DeliveryContext = Parameters<ReturnType<typeof createWorkerDelivery>['deliver']>[0];

interface SentMessage {
  customType?: unknown;
  content?: unknown;
  details?: unknown;
}

const manager = 't-manager';
const managerSession = '/sessions/manager.jsonl';

beforeEach(() => {
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const succeeded = (value: unknown) => ({
  code: 0,
  killed: false,
  truncated: false,
  stdout: JSON.stringify(value),
  stderr: '',
});

const createHc = (terminal: HcTerminal): HcRuntime => {
  const exec: Exec = (command, commandArguments) => {
    if (command === 'hc' && commandArguments[0] === 'ls') {
      return Promise.resolve(succeeded({ terminals: [{ ...terminal, labels: undefined }] }));
    }

    if (command === 'hc' && commandArguments[0] === 'get') {
      return Promise.resolve(succeeded(terminal));
    }

    return Promise.resolve({
      code: 1,
      killed: false,
      truncated: false,
      stdout: '',
      stderr: 'unexpected',
    });
  };

  return { exec, connect: () => Promise.reject(new Error('not used')), cwd: process.cwd() };
};

const savedAssignment = (directory: string, question: SavedQuestion): Assignment => {
  const assignmentId = randomUUID();
  const sessionId = randomUUID();

  return {
    version: 3,
    assignmentId,
    task: 'Inspect the counters.',
    acceptance: [],
    label: null,
    profile: 'worker',
    loadout: fixtureLoadout(directory),
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`) },
    parentSession: managerSession,
    cwd: directory,
    parentTerminal: manager,
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: null,
    questions: [question],
    report: null,
  };
};

it('gives the manager the assignment ID and question ID in the question content', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-delivery-answer-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  const question: SavedQuestion = {
    questionId: randomUUID(),
    text: 'Which branch should I use?',
    askedAt: Date.now(),
  };

  const saved = savedAssignment(directory, question);

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const messages: SentMessage[] = [];

  const pi = {
    on: () => undefined,
    sendMessage: (message: SentMessage) => messages.push(message),
  } as unknown as ExtensionAPI;

  const context = {
    sessionManager: { getEntries: () => [], getSessionFile: () => managerSession },
    ui: { notify: () => undefined },
    isIdle: () => true,
    signal: undefined,
  } as unknown as DeliveryContext;

  const hc = createHc({
    address: 't-child',
    state: 'live',
    parent: manager,
    labels: { 'tau.assignment': path },
  });

  createWorkerDelivery(pi).deliver(context, await readWorkerChildren(hc, manager));

  expect(messages).toHaveLength(1);

  const content = String(messages[0]?.content);

  expect(content).toContain(question.text);
  expect(content).toContain(saved.assignmentId);
  expect(content).toContain(question.questionId);
});
