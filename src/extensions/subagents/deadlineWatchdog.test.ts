import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { failedResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { createDeadlineWatchdog } from './deadlineWatchdog.js';
import type { DeadlineWatchdogContext } from './deadlineWatchdog.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { registerDeadlineWatchdog } from './subagents.js';
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
  const notifications: [string, string | undefined][] = [];

  const delivery: WorkerDelivery = {
    deliver: () => undefined,
    showEnded: (_context, assignmentId) => {
      ended.push(assignmentId);
    },
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

  return { context, ended, notifications, scanner, hc, emit, commands };
};

const setup = async (
  options: { deadline?: number; sendFails?: boolean; reported?: boolean } = {},
) => {
  const deadline = options.deadline ?? now + 300_000;
  const directory = temporaryDirectory(onTestFinished, 'tau-deadline-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  const path = await savedAssignment(directory, deadline, options.reported ?? false);
  const hcFake = createHcFake();

  hcFake.reply('ls', JSON.stringify({ terminals: [childRow] }));
  hcFake.reply('get', JSON.stringify(terminal(path, deadline)));
  hcFake.reply('send', JSON.stringify({ turn: 1 }));
  hcFake.reply('kill', JSON.stringify({ address: 't-child', state: 'finished' }));

  if (options.sendFails === true) {
    hcFake.fail('send', JSON.stringify({ error: { kind: 'blocked', message: 'blocked' } }), 1);
  }

  return { path, deadline, hcFake, ...harness(hcFake) };
};

const standalone = (hcFake: HcFake) => {
  hcFake.reply('ls', JSON.stringify({ terminals: [childRow] }));
  hcFake.reply('kill', JSON.stringify({ address: 't-child', state: 'finished' }));

  return harness(hcFake);
};

it('warns at the reserve and kills at the deadline', async () => {
  const { context, scanner, deadline, ended, commands } = await setup();

  await scanner.scan(context);

  await vi.advanceTimersByTimeAsync(deadline - reserve - now - 1);

  expect(commands('send')).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(1);

  expect(commands('send')).toHaveLength(1);

  expect(commands('send')[0]?.commandArguments.at(-1)).toBe(
    'Deadline in 90 s: call subagent_report now with what you have; blockerKind time is accepted.',
  );

  expect(commands('kill')).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(reserve);

  await vi.waitFor(() => {
    expect(commands('kill')).toHaveLength(1);
  });

  expect(ended).toHaveLength(1);
});

it('kills after hc refuses the warning', async () => {
  const { context, scanner, deadline, notifications, commands } = await setup({ sendFails: true });

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(deadline - reserve - now);

  expect(commands('send')).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(reserve);

  await vi.waitFor(() => {
    expect(commands('kill')).toHaveLength(1);
  });

  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.[0]).toContain('Warning t-child failed');
  expect(notifications[0]?.[1]).toBe('error');
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
  expect(vi.getTimerCount()).toBe(2);
});

it('keeps a known deadline when a child read fails', async () => {
  const { context, scanner, hcFake, notifications } = await setup();

  await scanner.scan(context);

  expect(vi.getTimerCount()).toBe(2);

  hcFake.fail('get', 'temporary read failure', 1);
  await scanner.scan(context);

  expect(vi.getTimerCount()).toBe(2);
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

it('warns at once when less than the reserve is left', async () => {
  const { context, scanner, commands } = await setup({ deadline: now + 30_000 });

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(0);

  expect(commands('send')).toHaveLength(1);

  expect(commands('send')[0]?.commandArguments.at(-1)).toBe(
    'Deadline in 30 s: call subagent_report now with what you have; blockerKind time is accepted.',
  );
});

it('kills at once when the assignment file is missing', async () => {
  const hcFake = createHcFake();

  hcFake.reply('get', JSON.stringify(terminal('/agent/missing.json', now + 300_000)));

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

it('sends one warning when a rescan clamps the warning time', async () => {
  const { context, scanner, commands } = await setup({ deadline: now + 30_000 });

  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(0);

  expect(commands('send')).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(1_000);
  await scanner.scan(context);
  await vi.advanceTimersByTimeAsync(0);

  expect(commands('send')).toHaveLength(1);
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
