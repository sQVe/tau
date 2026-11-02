import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../command.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { createReportDelivery } from './reportDelivery.js';

type DeliveryContext = Parameters<ReturnType<typeof createReportDelivery>['deliver']>[0];

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

const manager = 't-manager';

beforeEach(() => {
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const liveTerminal = (
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
  stdout: JSON.stringify(value),
  stderr: '',
});

// `ls` rows carry no labels, so every label read goes through `get`.
const createHc = (terminals: HcTerminal[]): HcRuntime => {
  const exec: Exec = (command, commandArguments) => {
    if (command !== 'hc') {
      return Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'unexpected' });
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
        ? Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'not_found' })
        : Promise.resolve(succeeded(terminal));
    }

    return Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'unexpected' });
  };

  return { exec, connect: () => Promise.reject(new Error('not used')), cwd: process.cwd() };
};

const customMessageEntry = (message: SentMessage): SessionEntryLike => ({
  type: 'custom_message',
  ...(typeof message.customType === 'string' ? { customType: message.customType } : {}),
  details: message.details,
});

// Models Pi: while streaming, `sendMessage` only queues the message in memory. The message becomes
// a session entry when the turn drains, while `appendEntry` writes at once.
const createManager = () => {
  const messages: SentMessage[] = [];
  const entries: SessionEntryLike[] = [];
  const queued: SentMessage[] = [];
  const notifications: [string, string | undefined][] = [];
  let streaming = false;

  const pi = {
    sendMessage: (message: SentMessage) => {
      messages.push(message);

      if (streaming) {
        queued.push(message);
      } else {
        entries.push(customMessageEntry(message));
      }
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ type: 'custom', customType, data });
    },
  } as unknown as ExtensionAPI;

  const context = {
    sessionManager: { getEntries: () => entries },
    ui: {
      notify: (message: string, kind: string | undefined) => notifications.push([message, kind]),
    },
  } as unknown as DeliveryContext;

  return {
    pi,
    context,
    messages,
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

const savedAssignment = (directory: string, report: Assignment['report']): Assignment => {
  const assignmentId = randomUUID();
  const sessionId = randomUUID();

  return {
    version: 1,
    assignmentId,
    task: 'Inspect the counters.',
    acceptance: [],
    label: null,
    profile: 'worker',
    loadout: fixtureLoadout(directory),
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`) },
    parentSession: join(directory, 'parent.jsonl'),
    cwd: directory,
    parentTerminal: manager,
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    report,
  };
};

const stubAgentDirectory = (): string => {
  const directory = temporaryDirectory(onTestFinished, 'tau-delivery-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  return directory;
};

const savedReport = (): Assignment['report'] => ({
  outcome: 'success',
  summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
  evidence: ['a reference'],
});

const reportDelivery = async (
  report: Assignment['report'] = savedReport(),
): Promise<{
  managerState: ReturnType<typeof createManager>;
  deliver: ReturnType<typeof createReportDelivery>['deliver'];
  assignmentId: string;
}> => {
  const directory = stubAgentDirectory();
  const saved = savedAssignment(directory, report);

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const managerState = createManager();
  const hc = createHc([liveTerminal('t-child', manager, { 'tau.assignment': path })]);

  return {
    managerState,
    deliver: createReportDelivery(managerState.pi, hc).deliver,
    assignmentId: saved.assignmentId,
  };
};

it('notifies an error for a missing assignment file', async () => {
  const managerState = createManager();

  const hc = createHc([
    liveTerminal('t-child', manager, { 'tau.assignment': '/agent/missing.json' }),
  ]);

  await createReportDelivery(managerState.pi, hc).deliver(managerState.context);

  expect(managerState.notifications).toEqual([
    ['Missing assignment file: /agent/missing.json.', 'error'],
  ]);

  expect(managerState.messages).toEqual([]);
});

it('notifies an error for a malformed assignment file', async () => {
  const directory = stubAgentDirectory();
  const path = join(directory, 'assignment.json');

  writeFileSync(path, JSON.stringify({ version: 1, assignmentId: 'not-a-uuid' }));

  const managerState = createManager();
  const hc = createHc([liveTerminal('t-child', manager, { 'tau.assignment': path })]);

  await createReportDelivery(managerState.pi, hc).deliver(managerState.context);

  expect(managerState.notifications).toHaveLength(1);
  expect(managerState.notifications[0]?.[0]).toContain('Malformed assignment');
  expect(managerState.messages).toEqual([]);
});

it('skips a child without an assignment label', async () => {
  const managerState = createManager();
  const hc = createHc([liveTerminal('t-child', manager)]);

  await createReportDelivery(managerState.pi, hc).deliver(managerState.context);

  expect(managerState.notifications).toEqual([]);
  expect(managerState.messages).toEqual([]);
});

it('ignores an assignment whose report is not written yet', async () => {
  const directory = stubAgentDirectory();
  const saved = savedAssignment(directory, null);

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');

  const managerState = createManager();
  const hc = createHc([liveTerminal('t-child', manager, { 'tau.assignment': path })]);

  await createReportDelivery(managerState.pi, hc).deliver(managerState.context);

  expect(managerState.notifications).toEqual([]);
  expect(managerState.messages).toEqual([]);
});

it('skips a terminal that is not the manager child', async () => {
  const managerState = createManager();

  const hc = createHc([
    liveTerminal('t-other', 't-elsewhere', { 'tau.assignment': '/agent/missing.json' }),
    liveTerminal('t-child', manager),
  ]);

  await createReportDelivery(managerState.pi, hc).deliver(managerState.context);

  expect(managerState.notifications).toEqual([]);
  expect(managerState.messages).toEqual([]);
});

it('does nothing without a manager terminal', async () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const managerState = createManager();

  const hc = createHc([
    liveTerminal('t-child', manager, { 'tau.assignment': '/agent/missing.json' }),
  ]);

  await createReportDelivery(managerState.pi, hc).deliver(managerState.context);

  expect(managerState.notifications).toEqual([]);
  expect(managerState.messages).toEqual([]);
});

it('keeps a queued report out of the saved session until its message is saved', async () => {
  const { managerState, deliver, assignmentId } = await reportDelivery();

  managerState.setStreaming(true);

  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);
  expect(managerState.entries).toEqual([]);

  // A second note while the first report is still queued queues no second report.
  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);
  expect(managerState.entries).toEqual([]);

  managerState.flush();

  expect(managerState.entries).toEqual([
    {
      type: 'custom_message',
      customType: 'tau-worker-report',
      details: { assignmentId, outcome: 'success' },
    },
  ]);

  // The saved report message is the record, so another note shows nothing new.
  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);
});

it('shows a new report once and records it as a report message', async () => {
  const { managerState, deliver, assignmentId } = await reportDelivery();

  // Foreign entries and an incomplete report message must not hide the saved report.
  managerState.entries.push(
    { type: 'custom_message', customType: 'other-extension', details: { assignmentId: 'other' } },
    { type: 'custom_message', customType: 'tau-worker-report', details: {} },
  );

  await deliver(managerState.context);
  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);

  expect(managerState.entries).toEqual([
    { type: 'custom_message', customType: 'other-extension', details: { assignmentId: 'other' } },
    { type: 'custom_message', customType: 'tau-worker-report', details: {} },
    {
      type: 'custom_message',
      customType: 'tau-worker-report',
      details: { assignmentId, outcome: 'success' },
    },
  ]);
});

it('restores the shown state from a saved report message for a fresh delivery', async () => {
  const { managerState, deliver, assignmentId } = await reportDelivery();

  // A new delivery over a session that already recorded the report must treat it as shown.
  managerState.entries.push({
    type: 'custom_message',
    customType: 'tau-worker-report',
    details: { assignmentId, outcome: 'success' },
  });

  await deliver(managerState.context);

  expect(managerState.messages).toEqual([]);
  expect(managerState.entries).toHaveLength(1);
});

it.each(['success', 'failure'] as const)(
  'shows the saved %s outcome in the report content and details',
  async (outcome) => {
    const { managerState, deliver, assignmentId } = await reportDelivery({
      outcome,
      summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
      evidence: [],
    });

    await deliver(managerState.context);

    expect(managerState.messages).toHaveLength(1);

    const message = managerState.messages[0] as { content: string; details: unknown };

    expect(message.content).toContain(`Worker report ${assignmentId}: ${outcome}`);
    expect(message.details).toEqual({ assignmentId, outcome });
  },
);
