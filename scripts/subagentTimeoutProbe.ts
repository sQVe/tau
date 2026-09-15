import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { cancelOwnedWorker, runClient } from './subagentTimeout.ts';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const field = (value: unknown, key: string): unknown => {
  assert.ok(isObject(value));

  return value[key];
};
const text = (value: unknown): string => {
  assert.ok(typeof value === 'string');

  return value;
};
const integer = (value: unknown): number => {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value));

  return value;
};
const until = async (check: () => boolean | Promise<boolean>) => {
  const deadline = performance.now() + 15_000;

  // oxlint-disable-next-line eslint/no-await-in-loop -- The next observation depends on real process readiness.
  while (!(await check())) {
    assert.ok(performance.now() < deadline, 'Probe readiness budget expired.');
    // oxlint-disable-next-line eslint/no-await-in-loop -- Real readiness polling is bounded and confined to the isolated probe.
    await delay(50);
  }
};

assert.ok(process.platform === 'linux' || process.platform === 'darwin');
// oxlint-disable-next-line node/no-process-env -- Explicit user invocation must originate in an authorized herdr pane.
assert.equal(process.env.HERDR_ENV, '1');
const root = mkdtempSync(join(tmpdir(), 'tau-abu392-'));
const session = 'deadline-probe';
// Do not inherit the active server socket, credentials, shell configuration, or Pi resources.
const environment = {
  // oxlint-disable-next-line node/no-process-env -- Only PATH is inherited for the installed herdr, Pi, and Node binaries.
  PATH: process.env.PATH,
  HOME: root,
  XDG_CONFIG_HOME: join(root, 'config'),
  HERDR_CONFIG_PATH: join(root, 'herdr.toml'),
  PI_CODING_AGENT_DIR: join(root, 'agent'),
  SHELL: '/bin/sh',
  TERM: 'xterm-256color',
};
writeFileSync(
  environment.HERDR_CONFIG_PATH,
  'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n',
);
const observations: unknown[] = [];
const client = async (arguments_: string[], budget = 3000, signal?: AbortSignal) => {
  const response = await runClient(
    'herdr',
    ['--session', session, ...arguments_],
    budget,
    signal,
    environment,
  );
  observations.push({ arguments: arguments_, response });

  return response;
};
const result = async (arguments_: string[], budget?: number) => {
  const response: unknown = JSON.parse(await client(arguments_, budget));

  return field(response, 'result');
};
const startPi = (name: string, pane: string, sessionPath: string) =>
  result(
    [
      'agent',
      'start',
      name,
      '--kind',
      'pi',
      '--pane',
      pane,
      '--timeout',
      '15000',
      '--',
      '--offline',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-tools',
      '--no-approve',
      '--session',
      sessionPath,
      '-e',
      join(root, 'agent', 'extensions', 'herdr-agent-state.ts'),
      '-e',
      resolve('scripts/subagentTimeoutPiFixture.ts'),
    ],
    17_000,
  );

const server = spawn('herdr', ['--session', session, 'server'], {
  env: environment,
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverExit = once(server, 'exit');
server.stdout.on('data', (data: Buffer) => observations.push({ server: data.toString() }));
server.stderr.on('data', (data: Buffer) => observations.push({ server: data.toString() }));
let passed = false;
let cleanup = 'unconfirmed';

process.stdout.write(`Isolated evidence directory: ${root}\n`);
try {
  await until(() => existsSync(join(root, 'config', 'herdr', 'sessions', session, 'herdr.sock')));
  mkdirSync(join(root, 'agent', 'extensions'), { recursive: true });
  await runClient('herdr', ['integration', 'install', 'pi'], 3000, undefined, environment);
  const workspace = await result(['workspace', 'create', '--cwd', root, '--no-focus']);
  const parentPane = text(field(field(workspace, 'root_pane'), 'pane_id'));
  const split = await result([
    'pane',
    'split',
    '--pane',
    parentPane,
    '--direction',
    'right',
    '--cwd',
    root,
    '--no-focus',
  ]);
  const workerPane = text(field(field(split, 'pane'), 'pane_id'));
  const token = join(root, 'ordinaryWorker.mjs');
  writeFileSync(
    token,
    "import { writeFileSync } from 'node:fs';\nif (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n",
  );
  await client([
    'pane',
    'run',
    workerPane,
    `${JSON.stringify(process.execPath)} ${JSON.stringify(token)}`,
  ]);

  let workerInfo: unknown;
  await until(async () => {
    workerInfo = field(
      await result(['pane', 'process-info', '--pane', workerPane]),
      'process_info',
    );

    return field(workerInfo, 'foreground_process_group_id') !== field(workerInfo, 'shell_pid');
  });
  const owned = {
    kind: 'process' as const,
    paneId: workerPane,
    shellPid: integer(field(workerInfo, 'shell_pid')),
    processId: integer(field(workerInfo, 'foreground_process_group_id')),
    token,
  };
  writeFileSync(join(root, 'partial.txt'), 'Retained partial evidence.\n');
  const signal = new AbortController().signal;
  const refused = await cancelOwnedWorker(
    { ...owned, token: `${token}.replaced` },
    1000,
    client,
    signal,
  );
  assert.equal(refused.cleanup, 'refused');
  const untouched = field(
    await result(['pane', 'process-info', '--pane', workerPane]),
    'process_info',
  );
  assert.equal(field(untouched, 'foreground_process_group_id'), owned.processId);

  for (const failure of ['unavailable', 'stalled']) {
    const startedAt = performance.now();
    // oxlint-disable-next-line eslint/no-await-in-loop -- Inject one failure at a time against the same owned fixture.
    const failed = await cancelOwnedWorker(
      owned,
      300,
      (arguments_, budget, attemptSignal) => {
        if (arguments_[1] !== 'send-keys') {
          return client(arguments_, budget, attemptSignal);
        }

        if (failure === 'unavailable') {
          return runClient('herdr', arguments_, budget, attemptSignal, {
            ...environment,
            HERDR_SOCKET_PATH: join(root, 'missing.sock'),
          });
        }

        return runClient(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          budget,
          attemptSignal,
        );
      },
      signal,
    );
    const elapsed = performance.now() - startedAt;
    assert.equal(failed.cleanup, 'unconfirmed');
    assert.match(failed.detail, /manual cleanup/);
    assert.ok(elapsed < 1500);
    assert.equal(process.kill(owned.processId, 0), true);
    observations.push({
      injectedClientFailure: failure,
      elapsed,
      result: failed,
      workerStillAlive: true,
    });
  }

  const ordinaryCleanup = await cancelOwnedWorker(owned, 1000, client, signal);
  assert.equal(ordinaryCleanup.cleanup, 'confirmed');
  observations.push({ ordinaryCleanup });

  const workerSession = join(root, 'worker.jsonl');
  observations.push({
    canonicalWorkerStart: await startPi('deadline-worker', workerPane, workerSession),
  });
  const piInfo = field(
    await result(['pane', 'process-info', '--pane', workerPane]),
    'process_info',
  );
  const piOwned = {
    kind: 'pi' as const,
    paneId: workerPane,
    shellPid: integer(field(piInfo, 'shell_pid')),
    processId: integer(field(piInfo, 'foreground_process_group_id')),
    token: workerSession,
  };
  writeFileSync(join(root, 'owned.json'), JSON.stringify(piOwned));
  const childPidFile = join(root, 'piChildPid');
  await client([
    'agent',
    'prompt',
    'deadline-worker',
    `!!${JSON.stringify(process.execPath)} ${JSON.stringify(token)} ${JSON.stringify(childPidFile)}`,
  ]);
  await until(() => existsSync(childPidFile));
  const piChildPid = Number(readFileSync(childPidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(piChildPid) && piChildPid > 0);

  const started = await startPi('deadline-parent', parentPane, join(root, 'parent.jsonl'));
  observations.push({ canonicalStart: started });
  const recognized = field(await result(['agent', 'get', 'deadline-parent']), 'agent');
  assert.equal(field(recognized, 'agent'), 'pi');
  assert.equal(field(recognized, 'interactive_ready'), true);

  const start = performance.now();
  await client(['agent', 'prompt', 'deadline-parent', '/deadline-probe arm']);
  await until(() => existsSync(join(root, 'arm.json')));
  await delay(1000);
  await client(['agent', 'prompt', 'deadline-parent', '/deadline-probe activity']);
  await until(() => existsSync(join(root, 'activity.json')));
  await client(['agent', 'prompt', 'deadline-parent', '/deadline-probe reconnect']);
  await until(() => existsSync(join(root, 'reconnect.json')));
  const armed: unknown = JSON.parse(readFileSync(join(root, 'arm.json'), 'utf8'));
  const reconnected: unknown = JSON.parse(readFileSync(join(root, 'reconnect.json'), 'utf8'));
  assert.deepEqual(reconnected, armed);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'activity.json'), 'utf8')) as unknown, armed);
  await until(() => existsSync(join(root, 'result.json')));
  const outcome: unknown = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
  assert.equal(field(outcome, 'reason'), 'timeout');
  assert.equal(field(outcome, 'output'), 'incomplete');
  assert.equal(field(outcome, 'cleanup'), 'confirmed');
  const timeoutElapsed = performance.now() - start;
  assert.ok(timeoutElapsed < 7000);
  assert.throws(() => process.kill(piOwned.processId, 0));
  await until(() => {
    try {
      process.kill(piChildPid, 0);

      return false;
    } catch (error) {
      assert.ok(error instanceof Error && 'code' in error && error.code === 'ESRCH');

      return true;
    }
  });
  observations.push({
    piCancellation: outcome,
    timeoutElapsed,
    piProcessAbsent: true,
    ordinaryPiChildAbsent: true,
  });
  assert.equal(process.kill(integer(field(armed, 'parentPid')), 0), true);

  const saved = readFileSync(join(root, 'result.json'), 'utf8');
  await client(['agent', 'prompt', 'deadline-parent', '/deadline-probe exit']);
  await until(async () => {
    const info = field(
      await result(['pane', 'process-info', '--pane', parentPane]),
      'process_info',
    );

    return field(info, 'foreground_process_group_id') === field(info, 'shell_pid');
  });
  assert.equal(readFileSync(join(root, 'result.json'), 'utf8'), saved);
  assert.equal(readFileSync(join(root, 'partial.txt'), 'utf8'), 'Retained partial evidence.\n');
  passed = true;
} catch (error) {
  observations.push({ error: String(error) });
  throw error;
} finally {
  try {
    await client(['server', 'stop']);
    await Promise.race([
      serverExit,
      delay(3000).then(() => {
        throw new Error('Isolated server exit unconfirmed.');
      }),
    ]);
    cleanup = 'isolated server exited';
  } finally {
    writeFileSync(
      join(root, 'observations.json'),
      JSON.stringify({ platform: process.platform, passed, cleanup, observations }, null, 2),
    );
    process.stdout.write(`${JSON.stringify({ passed, cleanup, root })}\n`);
  }
}
