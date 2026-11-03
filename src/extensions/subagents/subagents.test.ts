import { randomUUID } from 'node:crypto';
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
import type { ReportDelivery } from './reportDelivery.js';
import { registerReportDelivery } from './subagents.js';

const manager = 't-manager';

beforeEach(() => {
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const liveTerminal = (labels?: Record<string, string>): HcTerminal => ({
  address: 't-child',
  state: 'live',
  parent: manager,
  ...(labels === undefined ? {} : { labels }),
});

const succeeded = (value: unknown) => ({
  code: 0,
  killed: false,
  stdout: JSON.stringify(value),
  stderr: '',
});

const createHc = (options: { terminal?: HcTerminal; lsFails?: boolean } = {}): HcRuntime => {
  const exec: Exec = (command, commandArguments) => {
    if (command !== 'hc') {
      return Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'unexpected' });
    }

    if (commandArguments[0] === 'ls') {
      return options.lsFails === true
        ? Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'boom' })
        : Promise.resolve(succeeded({ terminals: [liveTerminal()] }));
    }

    if (commandArguments[0] === 'get') {
      return Promise.resolve(succeeded(options.terminal ?? liveTerminal()));
    }

    return Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'unexpected' });
  };

  return { exec, connect: () => Promise.reject(new Error('not used')), cwd: process.cwd() };
};

const createPi = () => {
  const handlers = new Map<string, (event: { text: string }, context: unknown) => unknown>();
  const messages: unknown[] = [];

  const pi = {
    on: (eventName: string, handler: (event: { text: string }, context: unknown) => unknown) => {
      handlers.set(eventName, handler);
    },
    sendMessage: (message: unknown) => messages.push(message),
  } as unknown as ExtensionAPI;

  return { pi, handlers, messages };
};

const createContext = () => {
  const entries: unknown[] = [];
  const notifications: [string, string | undefined][] = [];

  return {
    entries,
    notifications,
    context: {
      sessionManager: { getEntries: () => entries },
      ui: {
        notify: (message: string, kind: string | undefined) => notifications.push([message, kind]),
      },
    },
  };
};

const completionTracked = (delivery: ReportDelivery) => {
  let tail: Promise<void> = Promise.resolve();

  return {
    delivery: {
      deliver: (context: Parameters<ReportDelivery['deliver']>[0]) => {
        const next = tail.then(() => delivery.deliver(context));

        tail = next.catch(() => undefined);

        return next;
      },
    },
    settled: () => tail,
  };
};

const savedAssignment = (directory: string): Assignment => {
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
    report: {
      outcome: 'success',
      summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
      evidence: [],
    },
  };
};

it('shows one report message for the same note twice', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-note-');
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  const saved = savedAssignment(directory);

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const { pi, handlers, messages } = createPi();
  const { context } = createContext();
  const hc = createHc({ terminal: liveTerminal({ 'tau.assignment': path }) });

  const tracked = completionTracked(createReportDelivery(pi, hc));

  registerReportDelivery(pi, tracked.delivery);

  const input = handlers.get('input');

  if (input === undefined) {
    throw new Error('no input handler registered');
  }

  input({ text: `[tau-report] ${path}` }, context);
  input({ text: `[tau-report] ${path}` }, context);

  await tracked.settled();

  expect(messages).toHaveLength(1);
});

it('reports a failed delivery with an error notification', async () => {
  const { pi, handlers, messages } = createPi();
  const { context, notifications } = createContext();
  const hc = createHc({ lsFails: true });

  const tracked = completionTracked(createReportDelivery(pi, hc));

  registerReportDelivery(pi, tracked.delivery);

  const input = handlers.get('input');

  if (input === undefined) {
    throw new Error('no input handler registered');
  }

  input({ text: '[tau-report] /agent/assignment.json' }, context);

  await tracked.settled();

  expect(messages).toEqual([]);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.[0]).toContain('hc ls failed: boom');
  expect(notifications[0]?.[1]).toBe('error');
});
