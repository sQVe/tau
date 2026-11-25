import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { Assignment, SavedQuestion } from '../assignment.js';
import { assignmentDirectory } from '../assignment.js';
import type { createWorkerDelivery } from '../workerDelivery.js';
import { fixtureLoadout } from './loadout.js';

export type DeliveryContext = Parameters<ReturnType<typeof createWorkerDelivery>['deliver']>[0];

interface SentMessage {
  customType?: unknown;
  details?: unknown;
}

interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

interface SessionEntries {
  entries: SessionEntryLike[];
  branchEntries: SessionEntryLike[];
}

interface Manager {
  pi: ExtensionAPI;
  context: DeliveryContext;
  messages: SentMessage[];
  sendOptions: unknown[];
  entries: SessionEntryLike[];
  branchEntries: SessionEntryLike[];
  notifications: [string, string | undefined][];
  entriesOf: (sessionFile: string) => SessionEntryLike[];
  switchSession: (sessionFile: string) => void;
  setStreaming: (value: boolean) => void;
  flush: () => void;
}

export const manager = 't-manager';
export const managerSession = '/sessions/manager.jsonl';
export const otherSession = '/sessions/previous.jsonl';

const customMessageEntry = (message: SentMessage): SessionEntryLike => ({
  type: 'custom_message',
  ...(typeof message.customType === 'string' ? { customType: message.customType } : {}),
  details: message.details,
});

export const createManager = (options: { idle?: boolean; running?: boolean } = {}): Manager => {
  const messages: SentMessage[] = [];
  const sendOptions: unknown[] = [];

  const sessions = new Map<string, SessionEntries>([
    [managerSession, { entries: [], branchEntries: [] }],
  ]);

  const queued: SentMessage[] = [];
  const notifications: [string, string | undefined][] = [];
  let currentSession = managerSession;
  let streaming = false;

  const sessionOf = (sessionFile: string): SessionEntries => {
    const existing = sessions.get(sessionFile);

    if (existing !== undefined) {
      return existing;
    }

    const created = { entries: [], branchEntries: [] };

    sessions.set(sessionFile, created);

    return created;
  };

  const entriesOf = (sessionFile: string): SessionEntryLike[] => sessionOf(sessionFile).entries;

  const branchOf = (sessionFile: string): SessionEntryLike[] =>
    sessionOf(sessionFile).branchEntries;

  const pi = {
    on: () => undefined,
    sendMessage: (message: SentMessage, sendOption?: unknown) => {
      messages.push(message);
      sendOptions.push(sendOption);

      if (streaming) {
        queued.push(message);
      } else {
        entriesOf(currentSession).push(customMessageEntry(message));
      }
    },
  } as unknown as ExtensionAPI;

  const context = {
    sessionManager: {
      getEntries: () => entriesOf(currentSession),
      getBranch: () => branchOf(currentSession),
      getSessionFile: () => currentSession,
    },
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
    entries: entriesOf(managerSession),
    branchEntries: branchOf(managerSession),
    notifications,
    entriesOf,
    switchSession: (sessionFile: string) => {
      sessionOf(sessionFile);

      currentSession = sessionFile;
    },
    setStreaming: (value: boolean) => {
      streaming = value;
    },
    flush: () => {
      for (const message of queued.splice(0)) {
        entriesOf(currentSession).push(customMessageEntry(message));
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
    version: 4,
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
    fullCheck: null,
  };
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
