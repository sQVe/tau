import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../../command.js';
import type { HcRuntime, HcTerminal } from '../../../hc/hc.js';
import { assignmentDirectory, writeAssignment } from '../assignment.js';
import type { Assignment, SavedQuestion } from '../assignment.js';
import { createWorkerDelivery, readWorkerChildren } from '../workerDelivery.js';
import type { WorkerDelivery } from '../workerDelivery.js';
import { fixtureLoadout } from './loadout.js';

export type DeliveryContext = Parameters<ReturnType<typeof createWorkerDelivery>['deliver']>[0];

interface SentMessage {
  customType?: unknown;
  content?: unknown;
  details?: unknown;
}

interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

export interface ManagerState {
  pi: ExtensionAPI;
  context: DeliveryContext;
  messages: SentMessage[];
  sendOptions: unknown[];
  entries: SessionEntryLike[];
  notifications: [string, string | undefined][];
  setStreaming: (value: boolean) => void;
  flush: () => void;
}

export const manager = 't-manager';
export const managerSession = '/sessions/manager.jsonl';

export const liveTerminal = (
  address: string,
  parent: string,
  labels?: Record<string, string>,
): HcTerminal => ({
  address,
  state: 'live',
  parent,
  ...(labels === undefined ? {} : { labels }),
});

const succeeded = (value: unknown) => ({
  code: 0,
  killed: false,
  truncated: false,
  stdout: JSON.stringify(value),
  stderr: '',
});

// `ls` rows carry no labels, so every label read goes through `get`.
export const createHc = (terminals: HcTerminal[]): HcRuntime => {
  const exec: Exec = (command, commandArguments) => {
    if (command !== 'hc') {
      return Promise.resolve({
        code: 1,
        killed: false,
        truncated: false,
        stdout: '',
        stderr: 'unexpected',
      });
    }

    if (commandArguments[0] === 'ls') {
      return Promise.resolve(
        succeeded({
          terminals: terminals.map((terminal) => ({ ...terminal, labels: undefined })),
        }),
      );
    }

    if (commandArguments[0] === 'get') {
      const address = commandArguments.at(-1);
      const terminal = terminals.find((candidate) => candidate.address === address);

      return terminal === undefined
        ? Promise.resolve({
            code: 1,
            killed: false,
            truncated: false,
            stdout: '',
            stderr: 'not_found',
          })
        : Promise.resolve(succeeded(terminal));
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

const customMessageEntry = (message: SentMessage): SessionEntryLike => ({
  type: 'custom_message',
  ...(typeof message.customType === 'string' ? { customType: message.customType } : {}),
  details: message.details,
});

export const createManager = (
  options: { idle?: boolean; running?: boolean } = {},
): ManagerState => {
  const messages: SentMessage[] = [];
  const sendOptions: unknown[] = [];
  const entries: SessionEntryLike[] = [];
  const queued: SentMessage[] = [];
  const notifications: [string, string | undefined][] = [];
  let streaming = false;

  const pi = {
    on: () => undefined,
    sendMessage: (message: SentMessage, sendOption?: unknown) => {
      messages.push(message);
      sendOptions.push(sendOption);

      if (streaming) {
        queued.push(message);
      } else {
        entries.push(customMessageEntry(message));
      }
    },
  } as unknown as ExtensionAPI;

  const context = {
    sessionManager: { getEntries: () => entries, getSessionFile: () => managerSession },
    ui: {
      notify: (message: string, kind: string | undefined) => notifications.push([message, kind]),
    },
    isIdle: () => options.idle ?? true,
    signal: options.running === true ? new AbortController().signal : undefined,
  } as unknown as DeliveryContext;

  return {
    pi,
    context,
    messages,
    sendOptions,
    entries,
    notifications,
    setStreaming: (value: boolean) => {
      streaming = value;
    },
    flush: () => {
      for (const message of queued.splice(0)) {
        entries.push(customMessageEntry(message));
      }
    },
  };
};

export const savedAssignment = (
  directory: string,
  report: Assignment['report'],
  questions: SavedQuestion[] = [],
): Assignment => {
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
    questions,
    report,
  };
};

export const stubAgentDirectory = (): string => {
  const directory = temporaryDirectory(onTestFinished, 'tau-delivery-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  return directory;
};

export const savedReport = (): Assignment['report'] => ({
  outcome: 'success',
  summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
  evidence: ['a reference'],
});

export const savedQuestion = (): SavedQuestion => ({
  questionId: randomUUID(),
  text: 'Which branch should I use?',
  askedAt: Date.now(),
});

export const deliverPending = async (
  delivery: WorkerDelivery,
  hc: HcRuntime,
  context: DeliveryContext,
): Promise<void> => {
  delivery.deliver(context, await readWorkerChildren(hc, manager));
};

export const reportDelivery = async (
  report: Assignment['report'] = savedReport(),
  questions: SavedQuestion[] = [],
  managerOptions: { idle?: boolean; running?: boolean } = {},
): Promise<{
  managerState: ManagerState;
  deliver: (context: DeliveryContext) => Promise<void>;
  hc: HcRuntime;
  assignmentId: string;
}> => {
  const directory = stubAgentDirectory();
  const saved = savedAssignment(directory, report, questions);

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const managerState = createManager(managerOptions);
  const hc = createHc([liveTerminal('t-child', manager, { 'tau.assignment': path })]);
  const delivery = createWorkerDelivery(managerState.pi);

  return {
    managerState,
    deliver: (context) => deliverPending(delivery, hc, context),
    hc,
    assignmentId: saved.assignmentId,
  };
};
