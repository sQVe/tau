import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { succeededResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import type { Exec } from '../../command.js';
import { ownershipTiming } from '../../hc/ownership.js';
import piResumeExtension from './piResume.js';

// Every test file in a Vitest worker shares one process when isolation is off, and other files leave
// signal listeners that kill the process. Deliver the signal only to listeners added during the test.
type SignalUnderTest = 'SIGTERM' | 'SIGHUP';

const defaultSessionFile = '/sessions/a.jsonl';

const foregroundOf = (pid: number | null) =>
  pid === null ? null : { pid, name: 'pi', argv: ['pi'], cwd: '/repository' };

const terminal = (pid: number | null): string =>
  JSON.stringify({ address: 't7', state: 'live', foreground: foregroundOf(pid) });

const buildContext = (
  changes: { mode?: string; cwd?: string; sessionFile?: string | undefined } = {},
): ExtensionContext =>
  ({
    cwd: changes.cwd ?? '/repository',
    mode: changes.mode ?? 'tui',
    sessionManager: {
      getSessionFile: () => ('sessionFile' in changes ? changes.sessionFile : defaultSessionFile),
    },
  }) as unknown as ExtensionContext;

const mount = (fake: HcFake, exec: Exec = fake.exec) => {
  const api = fakeExtensionApi({ exec });

  piResumeExtension(api.pi);

  const start = (context: ExtensionContext = buildContext()) =>
    api.handler('session_start')({ type: 'session_start', reason: 'startup' }, context);

  const shutdown = (context: ExtensionContext = buildContext()) =>
    api.handler('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, context);

  return { start, shutdown };
};

const labelCalls = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'label')
    .map((call) => call.commandArguments.slice(3));

const answerProcessGroup =
  (exec: Exec, processGroup: number): Exec =>
  async (command, commandArguments, options) => {
    if (command === 'ps') {
      return succeededResult(`${String(processGroup)}\n`);
    }

    return exec(command, commandArguments, options);
  };

const waitForLabelCount = async (fake: HcFake, count: number): Promise<void> => {
  await vi.waitFor(() => {
    expect(labelCalls(fake)).toHaveLength(count);
  });
};

const waitForTerminalRead = async (fake: HcFake): Promise<void> => {
  await vi.waitFor(() => {
    expect(fake.calls.filter((call) => call.commandArguments[0] === 'get')).toHaveLength(1);
  });
};

let listenersBeforeTest: Record<SignalUnderTest, NodeJS.SignalsListener[]> = {
  SIGTERM: [],
  SIGHUP: [],
};

beforeEach(() => {
  listenersBeforeTest = {
    SIGTERM: process.listeners('SIGTERM'),
    SIGHUP: process.listeners('SIGHUP'),
  };
});

const emitSignal = (signal: SignalUnderTest) => {
  const addedByTest = process
    .listeners(signal)
    .filter((listener) => !listenersBeforeTest[signal].includes(listener));

  for (const listener of addedByTest) {
    listener(signal);
  }
};

describe('a signal sent to the session', () => {
  const unrelatedListeners = {
    SIGTERM: vi.fn<() => void>(),
    SIGHUP: vi.fn<() => void>(),
  };

  beforeAll(() => {
    process.on('SIGTERM', unrelatedListeners.SIGTERM);
    process.on('SIGHUP', unrelatedListeners.SIGHUP);
  });

  afterAll(() => {
    process.off('SIGTERM', unrelatedListeners.SIGTERM);
    process.off('SIGHUP', unrelatedListeners.SIGHUP);
  });

  it.each(['SIGTERM', 'SIGHUP'] as const)(
    'does not reach a %s listener that was there before the test',
    async (signal) => {
      vi.stubEnv('HC_TERMINAL_ID', 't7');
      const resume = mount(createHcFake());

      await resume.start();
      emitSignal(signal);
      await resume.shutdown();

      expect(unrelatedListeners[signal]).not.toHaveBeenCalled();
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('labels the owning TUI Pi session on start', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid));
  fake.reply('label', terminal(process.pid));
  const resume = mount(fake, answerProcessGroup(fake.exec, process.pid));

  await resume.start();
  await waitForLabelCount(fake, 1);
  expect(labelCalls(fake)).toEqual([['t7', 'pi.session=/sessions/a.jsonl', 'pi.cwd=/repository']]);

  await resume.shutdown();
});

it('labels the session when the terminal reports its foreground only after startup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  const processGroup = process.pid + 1;

  fake.reply('get', terminal(null));
  fake.reply('label', terminal(processGroup));

  const exec: Exec = async (command, commandArguments, options) => {
    if (command === 'ps') {
      return succeededResult(`${String(processGroup)}\n`);
    }

    const result = await fake.exec(command, commandArguments, options);

    if (commandArguments[0] === 'get') {
      fake.reply('get', terminal(processGroup));
    }

    return result;
  };

  const resume = mount(fake, exec);

  await resume.start();
  await waitForLabelCount(fake, 1);
  expect(labelCalls(fake)).toEqual([['t7', 'pi.session=/sessions/a.jsonl', 'pi.cwd=/repository']]);

  await resume.shutdown();
});

it('labels a pnpm exec session whose process group leads the terminal', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  const processGroup = process.pid + 1;

  fake.reply('get', terminal(processGroup));
  fake.reply('label', terminal(processGroup));

  const resume = mount(fake, answerProcessGroup(fake.exec, processGroup));

  await resume.start();
  await waitForLabelCount(fake, 1);
  expect(labelCalls(fake)).toEqual([['t7', 'pi.session=/sessions/a.jsonl', 'pi.cwd=/repository']]);

  await resume.shutdown();
});

it("writes no labels for a Pi started from another session's shell", async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  const processGroup = process.pid + 1;

  fake.reply('get', terminal(processGroup + 1));

  const resume = mount(fake, answerProcessGroup(fake.exec, processGroup));

  await resume.start();
  await waitForTerminalRead(fake);

  expect(labelCalls(fake)).toEqual([]);

  await resume.shutdown();
});

it('writes no labels when shutdown arrives during the wait', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  const processGroup = process.pid + 1;
  const readReached = Promise.withResolvers<undefined>();

  fake.reply('get', terminal(null));

  const exec: Exec = async (command, commandArguments, options) => {
    if (command === 'ps') {
      return succeededResult(`${String(processGroup)}\n`);
    }

    if (commandArguments[0] === 'get') {
      readReached.resolve(undefined);
    }

    return fake.exec(command, commandArguments, options);
  };

  const resume = mount(fake, exec);

  await resume.start();
  await readReached.promise;
  await expect(resume.shutdown()).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(ownershipTiming.deadlineMilliseconds);

  expect(labelCalls(fake)).toEqual([]);
});

it("keeps only the newest session's labels when a second start arrives during the wait", async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  const processGroup = process.pid + 1;
  const readReached = Promise.withResolvers<undefined>();
  let reportedPid: number | null = null;

  fake.reply('label', terminal(processGroup));

  const exec: Exec = async (command, commandArguments, options) => {
    if (command === 'ps') {
      return succeededResult(`${String(processGroup)}\n`);
    }

    if (commandArguments[0] === 'get') {
      readReached.resolve(undefined);

      return succeededResult(terminal(reportedPid));
    }

    return fake.exec(command, commandArguments, options);
  };

  const resume = mount(fake, exec);

  await resume.start();
  await readReached.promise;
  reportedPid = processGroup;
  await resume.start(buildContext({ sessionFile: '/sessions/b.jsonl' }));
  await waitForLabelCount(fake, 1);
  expect(labelCalls(fake)).toEqual([['t7', 'pi.session=/sessions/b.jsonl', 'pi.cwd=/repository']]);

  await resume.shutdown();
});

it('does not call hc for a nested non-interactive Pi', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  const resume = mount(fake);

  await resume.start(buildContext({ mode: 'print' }));
  await resume.shutdown();

  expect(fake.calls).toEqual([]);
});

it('does not call hc for a Pi without a terminal id', async () => {
  const fake = createHcFake();
  const resume = mount(fake);

  await resume.start();
  await resume.shutdown();

  expect(fake.calls).toEqual([]);
});

it('does not label a Pi that is not the terminal foreground process', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid + 1));
  const resume = mount(fake, answerProcessGroup(fake.exec, process.pid));

  await resume.start();
  await waitForTerminalRead(fake);

  expect(labelCalls(fake)).toEqual([]);

  await resume.shutdown();
});

it.each(['SIGTERM', 'SIGHUP'] as const)(
  'makes no hc label call when %s arrives while hc get is pending',
  async (signal) => {
    vi.stubEnv('HC_TERMINAL_ID', 't7');
    const calls: string[][] = [];

    let releaseGet: (() => void) | undefined;

    const pendingGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });

    const exec: Exec = async (_command, commandArguments) => {
      calls.push([...commandArguments]);

      if (commandArguments[0] === 'ps') {
        return succeededResult(`${String(process.pid)}\n`);
      }

      if (commandArguments[0] === 'get') {
        await pendingGet;
      }

      return succeededResult(terminal(process.pid));
    };

    const api = fakeExtensionApi({ exec });
    piResumeExtension(api.pi);

    const started = api.handler('session_start')(
      { type: 'session_start', reason: 'startup' },
      buildContext(),
    );

    emitSignal(signal);
    releaseGet?.();
    await started;

    await api.handler('session_shutdown')(
      { type: 'session_shutdown', reason: 'quit' },
      buildContext(),
    );

    expect(calls.filter((call) => call[0] === 'label')).toEqual([]);
  },
);

it('clears both labels on a quit without a signal', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid));
  fake.reply('label', terminal(process.pid));
  const resume = mount(fake, answerProcessGroup(fake.exec, process.pid));

  await resume.start();
  await waitForLabelCount(fake, 1);
  expect(labelCalls(fake)).toEqual([['t7', 'pi.session=/sessions/a.jsonl', 'pi.cwd=/repository']]);
  await resume.shutdown();

  const lastLabels = labelCalls(fake).at(-1);
  expect(lastLabels).toEqual(['t7', 'pi.session=', 'pi.cwd=']);
});

it.each(['SIGTERM', 'SIGHUP'] as const)('makes no hc call after %s', async (signal) => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid));
  fake.reply('label', terminal(process.pid));
  const resume = mount(fake, answerProcessGroup(fake.exec, process.pid));

  await resume.start();
  await waitForLabelCount(fake, 1);
  expect(labelCalls(fake)).toEqual([['t7', 'pi.session=/sessions/a.jsonl', 'pi.cwd=/repository']]);

  const callsBeforeSignal = fake.calls.length;

  emitSignal(signal);

  await resume.shutdown();

  expect(fake.calls.length).toBe(callsBeforeSignal);
});

it('overwrites the labels when a new session starts', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid));
  fake.reply('label', terminal(process.pid));
  const resume = mount(fake, answerProcessGroup(fake.exec, process.pid));

  await resume.start();
  await waitForLabelCount(fake, 1);
  await resume.start(buildContext({ sessionFile: '/sessions/b.jsonl' }));
  await waitForLabelCount(fake, 2);

  expect(labelCalls(fake)).toEqual([
    ['t7', 'pi.session=/sessions/a.jsonl', 'pi.cwd=/repository'],
    ['t7', 'pi.session=/sessions/b.jsonl', 'pi.cwd=/repository'],
  ]);

  await resume.shutdown();
});

it('does not clear labels after a non-owning Pi shuts down', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  const resume = mount(fake);

  await resume.start(buildContext({ mode: 'print' }));
  await resume.shutdown();

  expect(fake.calls).toEqual([]);
});
