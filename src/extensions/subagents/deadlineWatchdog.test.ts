import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { failedResult, succeededResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { assignmentDirectory, readAssignment, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { createDeadlineWatchdog } from './deadlineWatchdog.js';
import type { DeadlineWatchdogContext } from './deadlineWatchdog.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { registerDeadlineWatchdog } from './subagents.js';
import { createWorkerDelivery } from './workerDelivery.js';
import type { WorkerDelivery } from './workerDelivery.js';
import { createWorkerScan } from './workerScan.js';

const manager = 't-manager';
const now = 1_000_000;
const reserve = 90_000;

const deferred = () => {
  let settle!: () => void;

  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });

  return { promise, resolve: settle };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(now);
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const terminal = (
  path: string,
  deadline: number,
  overrides: Partial<HcTerminal> = {},
): HcTerminal => ({
  address: 't-child',
  state: 'live',
  parent: manager,
  labels: { 'tau.assignment': path, 'tau.deadline': String(deadline) },
  ...overrides,
});

const childRow = { address: 't-child', state: 'live', parent: manager };

const missingChild = (address: string, path: string): HcTerminal => ({
  address,
  state: 'live',
  parent: manager,
  labels: { 'tau.assignment': path },
});

const savedAssignment = async (
  directory: string,
  deadline: number,
  reported = false,
): Promise<string> => {
  const assignmentId = randomUUID();
  const sessionId = randomUUID();

  const assignment: Assignment = {
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
    parentSession: join(directory, 'parent.jsonl'),
    cwd: directory,
    parentTerminal: manager,
    deadline,
    createdAt: now,
    previousAssignmentId: null,
    extensionPackages: null,
    questions: [],
    report: reported
      ? {
          outcome: 'success',
          summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
          evidence: [],
        }
      : null,
  };

  await writeAssignment(assignment);

  return join(assignmentDirectory(assignmentId), 'assignment.json');
};

const harness = (hcFake: HcFake) => {
  const hc: HcRuntime = { exec: hcFake.exec, connect: hcFake.connect, cwd: process.cwd() };
  const ended: string[] = [];
  const order: string[] = [];
  const notifications: [string, string | undefined][] = [];

  const delivery: WorkerDelivery = {
    deliver: () => undefined,
    showEnded: (_context, assignmentId) => {
      order.push('showEnded');
      ended.push(assignmentId);
    },
    markDeadlinePending: () => undefined,
    clearDeadlinePending: () => undefined,
  };

  const context = {
    sessionManager: { getEntries: () => [] },
    ui: {
      notify: (message: string, kind: string | undefined) => {
        notifications.push([message, kind]);
      },
    },
  } as unknown as DeadlineWatchdogContext;

  const watchdog = createDeadlineWatchdog(hc, delivery);
  const scanner = createWorkerScan(hc, delivery, watchdog);
  const fake = fakeExtensionApi();

  registerDeadlineWatchdog(fake.pi, watchdog);

  const emit = async (name: string, event: unknown): Promise<void> => {
    for (const handler of fake.handlers.get(name) ?? []) {
      await handler(event as never, context as never);
    }
  };

  const commands = (name: string) =>
    hcFake.calls.filter((call) => call.commandArguments[0] === name);

  return { context, ended, order, notifications, scanner, hc, emit, commands };
};

const setup = async (options: { deadline?: number; reported?: boolean } = {}) => {
  const deadline = options.deadline ?? now + 300_000;
  const directory = temporaryDirectory(onTestFinished, 'tau-deadline-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  const path = await savedAssignment(directory, deadline, options.reported ?? false);
  const hcFake = createHcFake();

  hcFake.reply('ls', JSON.stringify({ terminals: [childRow] }));
  hcFake.reply('get', JSON.stringify(terminal(path, deadline)));
  hcFake.reply('kill', JSON.stringify({ address: 't-child', state: 'finished' }));
  hcFake.reply('label', JSON.stringify(terminal(path, deadline)));

  return { path, deadline, hcFake, ...harness(hcFake) };
};

const standalone = (hcFake: HcFake) => {
  hcFake.reply('ls', JSON.stringify({ terminals: [childRow] }));
  hcFake.reply('kill', JSON.stringify({ address: 't-child', state: 'finished' }));

  return harness(hcFake);
};

it('kills at the deadline without sending a warning', async () => {
  const { context, scanner, deadline, ended, commands } = await setup({ deadline: now + 120_000 });

  await scanner.scan(context);

  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(commands('kill')).toHaveLength(1);
  });

  expect(commands('send')).toHaveLength(0);
  expect(ended).toHaveLength(1);
});

it('labels the worker as ended at its deadline after the kill, once the deadline message is shown', async () => {
  const { context, scanner, hc, deadline, commands, order } = await setup();

  const realExec = hc.exec;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'kill' || commandArguments[0] === 'label') {
      order.push(commandArguments[0]);
    }

    return realExec(command, commandArguments, options);
  };

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(commands('label')).toHaveLength(1);
  });

  expect(order).toEqual(['kill', 'showEnded', 'label']);

  expect(commands('label')[0]?.commandArguments).toEqual([
    'label',
    '--json',
    '--',
    't-child',
    'tau.ended=deadline',
  ]);
});

it('still kills and reports one problem when the deadline label fails', async () => {
  const { context, scanner, deadline, notifications, commands, ended, hcFake } = await setup();

  hcFake.fail('label', JSON.stringify({ error: { kind: 'blocked', message: 'blocked' } }), 1);

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(commands('kill')).toHaveLength(1);
  });

  expect(ended).toHaveLength(1);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.[0]).toContain('Marking t-child as ended at its deadline failed');
  expect(notifications[0]?.[1]).toBe('error');
});

it('still kills when the deadline label reply omits labels and parent', async () => {
  const { context, scanner, hcFake, deadline, commands, ended } = await setup();

  hcFake.reply('label', JSON.stringify({ address: 't-child', state: 'live' }));

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(commands('kill')).toHaveLength(1);
  });

  expect(ended).toHaveLength(1);
});

it('makes no label call when the kill fails, and still retries the kill', async () => {
  const { context, scanner, hcFake, deadline, commands, ended } = await setup();

  hcFake.fail('kill', JSON.stringify({ error: { kind: 'blocked', message: 'blocked' } }), 1);

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(commands('kill')).toHaveLength(1);
  });

  await vi.advanceTimersByTimeAsync(5_000);

  await vi.waitFor(() => {
    expect(commands('kill')).toHaveLength(2);
  });

  expect(commands('label')).toHaveLength(0);
  expect(ended).toEqual([]);
});

const twoMissingChildren = (hcFake: HcFake) => {
  const terminals = [
    missingChild('t-first', '/agent/missing-first.json'),
    missingChild('t-second', '/agent/missing-second.json'),
  ];

  hcFake.reply('ls', JSON.stringify({ terminals }));
  hcFake.reply('kill', JSON.stringify({ address: 't-first', state: 'finished' }));

  const harnessed = harness(hcFake);
  const realExec = hcFake.exec;

  harnessed.hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'get') {
      const address = commandArguments.at(-1);
      const child = terminals.find((candidate) => candidate.address === address);

      return succeededResult(JSON.stringify(child));
    }

    return realExec(command, commandArguments, options);
  };

  return harnessed;
};

it('reports a failed deadline label once per child, with no retry', async () => {
  const hcFake = createHcFake();

  hcFake.fail('label', JSON.stringify({ error: { kind: 'blocked', message: 'blocked' } }), 1);

  const { context, scanner, notifications, commands } = twoMissingChildren(hcFake);

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(60_000);

  expect(commands('kill')).toHaveLength(2);
  expect(notifications.filter(([message]) => message.includes('t-first'))).toHaveLength(1);
  expect(notifications.filter(([message]) => message.includes('t-second'))).toHaveLength(1);

  await scanner.scan(context);

  expect(notifications.filter(([message]) => message.includes('t-first'))).toHaveLength(1);
  expect(notifications.filter(([message]) => message.includes('t-second'))).toHaveLength(1);
});

const customTypes = (messages: { customType?: unknown }[]): unknown[] =>
  messages.map((message) => message.customType);

const launchingDelivery = () => {
  const messages: { customType?: unknown; details?: unknown }[] = [];

  const pi = {
    on: () => undefined,
    sendMessage: (message: { customType?: unknown; details?: unknown }) => {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;

  return { delivery: createWorkerDelivery(pi), messages };
};

const launchingContext = (parentSession: string) =>
  ({
    sessionManager: { getEntries: () => [], getSessionFile: () => parentSession },
    ui: { notify: () => undefined },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as DeadlineWatchdogContext;

const parentSessionOf = async (path: string): Promise<string> => {
  const assignment = await readAssignment(path);

  if (assignment === undefined) {
    throw new Error('The assignment file is missing.');
  }

  return assignment.parentSession;
};

it('shows one deadline message when the worker finishes while its kill is pending', async () => {
  const { path, deadline, hc, hcFake, commands } = await setup();
  const context = launchingContext(await parentSessionOf(path));
  const { delivery, messages } = launchingDelivery();
  const watchdog = createDeadlineWatchdog(hc, delivery);
  const scanner = createWorkerScan(hc, delivery, watchdog);
  const killStarted = deferred();
  const killFinished = deferred();
  const realExec = hcFake.exec;
  let finished = false;
  let labelled = false;

  const labelsNow = (): Record<string, string> => {
    const labels = terminal(path, deadline).labels ?? {};

    return labelled ? { ...labels, 'tau.ended': 'deadline' } : labels;
  };

  const stateNow = (): string => (finished ? 'finished' : 'live');

  hc.exec = async (command, commandArguments, options) => {
    const [name] = commandArguments;

    if (name === 'ls') {
      return succeededResult(JSON.stringify({ terminals: [{ ...childRow, state: stateNow() }] }));
    }

    if (name === 'get') {
      return succeededResult(
        JSON.stringify({ ...terminal(path, deadline), state: stateNow(), labels: labelsNow() }),
      );
    }

    if (name === 'label') {
      labelled = true;

      return succeededResult(
        JSON.stringify({ ...terminal(path, deadline), state: stateNow(), labels: labelsNow() }),
      );
    }

    if (name === 'kill') {
      finished = true;
      killStarted.resolve();
      await killFinished.promise;
    }

    return realExec(command, commandArguments, options);
  };

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(deadline - now);
  await killStarted.promise;

  await scanner.scan(context);

  killFinished.resolve();

  await vi.waitFor(() => {
    expect(labelled).toBe(true);
  });

  await scanner.scan(context);

  expect(commands('kill')).toHaveLength(1);
  expect(customTypes(messages)).toEqual(['tau-worker-deadline']);
});

it('shows the generic ended message when a failed kill is followed by an unreported finish', async () => {
  const { path, deadline, hc, hcFake, commands } = await setup();
  const context = launchingContext(await parentSessionOf(path));
  const { delivery, messages } = launchingDelivery();
  const scanner = createWorkerScan(hc, delivery, createDeadlineWatchdog(hc, delivery));

  hcFake.fail('kill', JSON.stringify({ error: { kind: 'blocked', message: 'blocked' } }), 1);

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(commands('kill')).toHaveLength(1);
  });

  hcFake.reply('ls', JSON.stringify({ terminals: [{ ...childRow, state: 'finished' }] }));
  hcFake.reply('get', JSON.stringify({ ...terminal(path, deadline), state: 'finished' }));

  await scanner.scan(context);

  expect(customTypes(messages)).toEqual(['tau-worker-ended']);
});

it('skips the kill when hc get shows another parent', async () => {
  const { context, scanner, hcFake, deadline, path, commands } = await setup();

  await scanner.scan(context);

  hcFake.reply('get', JSON.stringify(terminal(path, deadline, { parent: 't-other' })));

  await vi.advanceTimersByTimeAsync(deadline - reserve - now);
  await vi.advanceTimersByTimeAsync(reserve);

  expect(commands('kill')).toHaveLength(0);
});

it('skips the kill when hc get shows another assignment', async () => {
  const { context, scanner, hcFake, deadline, commands } = await setup();

  await scanner.scan(context);

  hcFake.reply('get', JSON.stringify(terminal('/agent/other-assignment.json', deadline)));

  await vi.advanceTimersByTimeAsync(deadline - reserve - now);
  await vi.advanceTimersByTimeAsync(reserve);

  expect(commands('kill')).toHaveLength(0);
});

it('clears every timer at session shutdown', async () => {
  const { context, scanner, deadline, emit, commands } = await setup();

  await scanner.scan(context);

  await emit('session_shutdown', { reason: 'quit' });

  expect(vi.getTimerCount()).toBe(0);

  await vi.advanceTimersByTimeAsync(deadline - now + reserve);

  expect(commands('send')).toHaveLength(0);
  expect(commands('kill')).toHaveLength(0);
});

it('starts the newer scan read only after the older scan finishes', async () => {
  const { context, scanner, hcFake, hc } = await setup();
  const entered = deferred();
  const release = deferred();
  const realExec = hcFake.exec;
  let listCalls = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] !== 'ls') {
      return realExec(command, commandArguments, options);
    }

    listCalls += 1;

    const result = await realExec(command, commandArguments, options);

    if (listCalls === 1) {
      entered.resolve();
      await release.promise;
    }

    return result;
  };

  hcFake.reply('ls', JSON.stringify({ terminals: [] }));

  const oldScan = scanner.scan(context);

  await entered.promise;

  hcFake.reply('ls', JSON.stringify({ terminals: [childRow] }));

  const newScan = scanner.scan(context);

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(listCalls).toBe(1);

  release.resolve();

  await Promise.all([oldScan, newScan]);

  expect(listCalls).toBe(2);
  expect(vi.getTimerCount()).toBe(1);
});

it('keeps a known deadline when a child read fails', async () => {
  const { context, scanner, hcFake, notifications } = await setup();

  await scanner.scan(context);

  expect(vi.getTimerCount()).toBe(1);

  hcFake.fail('get', 'temporary read failure', 1);
  await scanner.scan(context);

  expect(vi.getTimerCount()).toBe(1);
  expect(notifications.some(([message]) => message.includes('Reading t-child failed'))).toBe(true);
});

it('arms nothing when a scan resumes after shutdown', async () => {
  const { context, scanner, hc, hcFake, deadline, emit, commands } = await setup();
  const entered = deferred();
  const release = deferred();
  const realExec = hcFake.exec;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'get') {
      entered.resolve();
      await release.promise;
    }

    return realExec(command, commandArguments, options);
  };

  const scanning = scanner.scan(context);

  await entered.promise;

  await emit('session_shutdown', { reason: 'quit' });
  release.resolve();
  await scanning;

  expect(vi.getTimerCount()).toBe(0);

  await vi.advanceTimersByTimeAsync(deadline - now + reserve);

  expect(commands('send')).toHaveLength(0);
  expect(commands('kill')).toHaveLength(0);
});

it('sends no kill when a callback resumes after shutdown', async () => {
  const { context, scanner, hc, hcFake, deadline, emit, commands } = await setup();

  await scanner.scan(context);

  const entered = deferred();
  const release = deferred();
  const realExec = hcFake.exec;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'get') {
      entered.resolve();
      await release.promise;
    }

    return realExec(command, commandArguments, options);
  };

  await vi.advanceTimersByTimeAsync(deadline - now);
  await entered.promise;

  await emit('session_shutdown', { reason: 'quit' });
  release.resolve();

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(commands('kill')).toHaveLength(0);
});

it('arms nothing for a child whose assignment already reported', async () => {
  const { context, scanner, deadline, commands } = await setup({ reported: true });

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(deadline - now + reserve);

  expect(commands('send')).toHaveLength(0);
  expect(commands('kill')).toHaveLength(0);
});

it('kills at once when the assignment file is missing', async () => {
  const hcFake = createHcFake();

  hcFake.reply('get', JSON.stringify(terminal('/agent/missing.json', now + 300_000)));
  hcFake.reply('label', JSON.stringify(terminal('/agent/missing.json', now + 300_000)));

  const { context, scanner, notifications, commands, ended } = standalone(hcFake);

  await scanner.scan(context);

  expect(commands('kill')).toHaveLength(1);
  expect(ended).toEqual([]);
  expect(notifications).toEqual([[`Missing assignment file: /agent/missing.json.`, 'error']]);
});

it('kills at once when the assignment file is malformed', async () => {
  const hcFake = createHcFake();
  const directory = temporaryDirectory(onTestFinished, 'tau-deadline-');
  const path = join(directory, 'assignment.json');

  writeFileSync(path, JSON.stringify({ version: 2, assignmentId: 'not-a-uuid' }));
  hcFake.reply('get', JSON.stringify(terminal(path, now + 300_000)));
  hcFake.reply('label', JSON.stringify(terminal(path, now + 300_000)));

  const { context, scanner, notifications, commands } = standalone(hcFake);

  await scanner.scan(context);

  expect(commands('kill')).toHaveLength(1);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.[0]).toContain('Malformed assignment');
});

it('reports an unread child without killing it', async () => {
  const hcFake = createHcFake();

  hcFake.fail('get', 'not_found', 1);

  const { context, scanner, notifications, commands } = standalone(hcFake);

  await scanner.scan(context);

  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.[0]).toContain('Reading t-child failed');
  expect(commands('kill')).toHaveLength(0);
});

it('retries a kill after hc get fails, then succeeds', async () => {
  const { context, scanner, hc, hcFake, deadline, ended } = await setup();

  await scanner.scan(context);

  const realExec = hcFake.exec;
  let getAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'get') {
      getAttempts += 1;

      if (getAttempts === 1) {
        return failedResult('temporary get failure');
      }
    }

    return realExec(command, commandArguments, options);
  };

  await vi.advanceTimersByTimeAsync(deadline - now);

  expect(getAttempts).toBe(1);

  await vi.advanceTimersByTimeAsync(5_000);

  await vi.waitFor(() => {
    expect(ended).toHaveLength(1);
  });

  expect(getAttempts).toBe(2);
});

it('keeps a pending kill retry when a rescan cannot read the child', async () => {
  const { context, scanner, hc, hcFake, deadline, ended } = await setup();

  await scanner.scan(context);

  const realExec = hcFake.exec;
  let getAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'get') {
      getAttempts += 1;

      if (getAttempts <= 2) {
        return failedResult('temporary get failure');
      }
    }

    return realExec(command, commandArguments, options);
  };

  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(getAttempts).toBe(1);
  });

  await scanner.scan(context);

  expect(getAttempts).toBe(2);

  await vi.advanceTimersByTimeAsync(5_000);

  await vi.waitFor(() => {
    expect(ended).toHaveLength(1);
  });

  expect(getAttempts).toBe(3);
});

it('retries a kill after hc kill fails, then succeeds', async () => {
  const { context, scanner, hc, hcFake, deadline, ended } = await setup();

  await scanner.scan(context);

  const realExec = hcFake.exec;
  let killAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'kill') {
      killAttempts += 1;

      if (killAttempts === 1) {
        return failedResult('temporary kill failure');
      }
    }

    return realExec(command, commandArguments, options);
  };

  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(killAttempts).toBe(1);
  });

  await vi.advanceTimersByTimeAsync(5_000);

  await vi.waitFor(() => {
    expect(ended).toHaveLength(1);
  });

  expect(killAttempts).toBe(2);
});

it('clears a pending kill retry when a rescan kills the worker', async () => {
  const { context, scanner, hc, hcFake, deadline, ended } = await setup();

  await scanner.scan(context);

  const realExec = hcFake.exec;
  let killAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'kill') {
      killAttempts += 1;

      if (killAttempts === 1) {
        return failedResult('temporary kill failure');
      }
    }

    return realExec(command, commandArguments, options);
  };

  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(killAttempts).toBe(1);
  });

  await scanner.scan(context);

  await vi.waitFor(() => {
    expect(ended).toHaveLength(1);
  });

  await vi.advanceTimersByTimeAsync(5_000);

  expect(killAttempts).toBe(2);
  expect(ended).toHaveLength(1);
});

it('retries a second kill failure with the next backoff', async () => {
  const { context, scanner, hc, hcFake, deadline, ended } = await setup();

  await scanner.scan(context);

  const realExec = hcFake.exec;
  let killAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'kill') {
      killAttempts += 1;

      if (killAttempts <= 2) {
        return failedResult('temporary kill failure');
      }
    }

    return realExec(command, commandArguments, options);
  };

  await vi.advanceTimersByTimeAsync(deadline - now);

  await vi.waitFor(() => {
    expect(killAttempts).toBe(1);
  });

  await vi.advanceTimersByTimeAsync(5_000);

  await vi.waitFor(() => {
    expect(killAttempts).toBe(2);
  });

  await vi.advanceTimersByTimeAsync(15_000);

  await vi.waitFor(() => {
    expect(ended).toHaveLength(1);
  });

  expect(killAttempts).toBe(3);
});

it('stops retrying a failed kill after the bounded schedule', async () => {
  const { context, scanner, hc, hcFake, deadline } = await setup();

  await scanner.scan(context);

  const realExec = hcFake.exec;
  let getAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'get') {
      getAttempts += 1;

      return failedResult('persistent get failure');
    }

    return realExec(command, commandArguments, options);
  };

  await vi.advanceTimersByTimeAsync(deadline - now);
  await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 45_000);
  await vi.advanceTimersByTimeAsync(1_000_000);

  expect(getAttempts).toBe(4);
});

it('cancels a pending kill retry at session shutdown', async () => {
  const { context, scanner, hc, hcFake, deadline, emit } = await setup();

  await scanner.scan(context);

  const realExec = hcFake.exec;
  let getAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'get') {
      getAttempts += 1;

      return failedResult('persistent get failure');
    }

    return realExec(command, commandArguments, options);
  };

  await vi.advanceTimersByTimeAsync(deadline - now);

  expect(getAttempts).toBe(1);

  await emit('session_shutdown', { reason: 'quit' });
  await vi.advanceTimersByTimeAsync(5_000);

  expect(getAttempts).toBe(1);
});
