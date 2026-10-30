import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { declinedExec } from '../../../tests/declinedExecFake.js';
import { initializeRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { LaunchParameters } from './launchParameters.js';
import { applyQaSettings } from './qaLaunch.js';

interface Fixture {
  worktree: string;
  writeUser: (value: unknown) => void;
}

vi.mock(import('node:child_process'), async (importOriginal) => {
  const original = await importOriginal();

  const spawnFake = vi.fn<typeof original.spawn>(original.spawn);

  return { ...original, spawn: spawnFake as unknown as typeof original.spawn };
});

afterEach(() => {
  vi.resetAllMocks();
});

const repository = 'sQVe/cape';

const notify = vi.fn<() => void>();

const fixture = async (origin: string | undefined): Promise<Fixture> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-qa-launch-');
  const agentDirectory = join(directory, 'agent');
  const worktree = join(directory, 'tree');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  mkdirSync(agentDirectory);
  mkdirSync(worktree);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  await initializeRepository(worktree);

  if (origin !== undefined) {
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: worktree });
  }

  return {
    worktree,
    writeUser: (value) => {
      writeFileSync(join(agentDirectory, 'tau.json'), JSON.stringify(value));
    },
  };
};

const settingsFor = (urlCommand: string) => ({
  qa: {
    repositories: {
      [repository]: { urlCommand, testAccountCommand: 'op read login', dataWrites: false },
    },
  },
});

const launch = (worktree: string, overrides: Partial<LaunchParameters> = {}): LaunchParameters => ({
  task: 'Test it.',
  profile: 'qa',
  cwd: worktree,
  ...overrides,
});

const context = (worktree: string) => ({
  cwd: worktree,
  isProjectTrusted: () => true,
  ui: { notify },
});

const apply = (parameters: LaunchParameters, worktree: string) =>
  applyQaSettings(parameters, undefined, context(worktree) as never, declinedExec);

const scriptPrinting = (worktree: string, output: string, exitCode = 0): string => {
  writeFileSync(
    join(worktree, 'dev-url'),
    `#!/bin/sh\nprintf '%s' '${output}'\nexit ${exitCode}\n`,
  );

  chmodSync(join(worktree, 'dev-url'), 0o755);

  return './dev-url';
};

it('takes the app URL from urlCommand run in the worktree and adds the brief lines', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser(settingsFor(scriptPrinting(worktree, 'http://localhost:4100\n')));

  const resolved = await apply(launch(worktree), worktree);

  expect(resolved.url).toBe('http://localhost:4100');
  expect(resolved.task).toContain('Test account: run `op read login` to read it.');
  expect(resolved.task).toContain('Data writes: not allowed in the dev database.');
});

it('keeps an explicit url and does not run urlCommand', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser(settingsFor('exit 1'));

  const resolved = await apply(launch(worktree, { url: 'http://localhost:9' }), worktree);

  expect(resolved.url).toBe('http://localhost:9');
  expect(resolved.task).toContain('Data writes:');
});

it.each([
  { condition: 'the command fails', output: 'http://localhost:1', exitCode: 3 },
  { condition: 'the output is empty', output: '', exitCode: 0 },
  { condition: 'the output is not http', output: 'ftp://host', exitCode: 0 },
])('refuses the launch when $condition', async ({ output, exitCode }) => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const command = scriptPrinting(worktree, output, exitCode);

  writeUser(settingsFor(command));

  const refusal = apply(launch(worktree), worktree);

  await expect(refusal).rejects.toThrow(command);
  await expect(refusal).rejects.toThrow('qa.repositories');
});

it('refuses at the deadline a urlCommand that ignores SIGTERM and kills its children', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const marker = join(worktree, 'survived');

  writeUser(settingsFor(`trap '' TERM; (sleep 0.5; touch survived) & sleep 30`));

  const started = performance.now();

  const refusal = applyQaSettings(
    launch(worktree),
    undefined,
    context(worktree) as never,
    declinedExec,
    200,
  );

  await expect(refusal).rejects.toThrow('qa.repositories');
  expect(performance.now() - started).toBeLessThan(900);

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 700);
  });

  expect(existsSync(marker)).toBe(false);
});

it('does not kill a background child of a successful urlCommand after the deadline', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const marker = join(worktree, 'survived');

  writeUser(
    settingsFor(`(sleep 0.6; touch survived) >/dev/null 2>&1 & echo http://localhost:4100`),
  );

  const resolved = await applyQaSettings(
    launch(worktree),
    undefined,
    context(worktree) as never,
    declinedExec,
    200,
  );

  expect(resolved.url).toBe('http://localhost:4100');

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 900);
  });

  expect(existsSync(marker)).toBe(true);
});

it('refuses a urlCommand whose output is over 1 MiB and kills its group', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const marker = join(worktree, 'survived');

  writeUser(
    settingsFor(
      `echo http://localhost:4100; head -c 2000000 /dev/zero | tr '\\0' ' '; sleep 0.5; touch survived`,
    ),
  );

  const refusal = apply(launch(worktree), worktree);

  await expect(refusal).rejects.toThrow('qa.repositories');

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 800);
  });

  expect(existsSync(marker)).toBe(false);
});

it('never runs testAccountCommand', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const marker = join(worktree, 'ran');

  writeUser({
    qa: {
      repositories: {
        [repository]: {
          urlCommand: 'echo http://localhost:1',
          testAccountCommand: `touch ${marker}`,
        },
      },
    },
  });

  await apply(launch(worktree), worktree);

  expect(existsSync(marker)).toBe(false);
});

it.each([
  {
    condition: 'the profile is browser',
    origin: 'git@github.com:sQVe/cape.git',
    profile: 'browser',
  },
  {
    condition: 'the origin names another repository',
    origin: 'git@github.com:sQVe/tau.git',
    profile: 'qa',
  },
  { condition: 'there is no origin', origin: undefined, profile: 'qa' },
])('leaves the launch unchanged when $condition', async ({ origin, profile }) => {
  const { worktree, writeUser } = await fixture(origin);

  writeUser(settingsFor('exit 1'));

  const parameters = launch(worktree, { profile });

  await expect(apply(parameters, worktree)).resolves.toBe(parameters);
});

it('fails a qa launch for a repository with a bad entry only', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser({ qa: { repositories: { [repository]: { dataWrites: 'yes' } } } });

  await expect(apply(launch(worktree), worktree)).rejects.toThrow('dataWrites');
  await expect(apply(launch(worktree, { profile: 'browser' }), worktree)).resolves.toBeDefined();
});

it('refuses a cwd outside the session before it reads settings or runs a command', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const other = join(worktree, 'other');
  const marker = join(worktree, 'ran');

  mkdirSync(other);
  writeUser(settingsFor(`touch ${marker}`));

  await expect(apply(launch(other), worktree)).rejects.toThrow("only in this session's cwd");
  expect(existsSync(marker)).toBe(false);
});

it('adds the brief lines and no url for a qa launch whose settings have no urlCommand', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser({
    qa: { repositories: { [repository]: { testAccountCommand: 'op read login' } } },
  });

  const resolved = await apply(launch(worktree), worktree);

  expect(resolved.url).toBeUndefined();
  expect(resolved.task).toContain('op read login');
});

it('refuses at the deadline when the caller passes a signal that never aborts', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser(settingsFor('sleep 30'));

  const refusal = applyQaSettings(
    launch(worktree),
    new AbortController().signal,
    context(worktree) as never,
    declinedExec,
    200,
  );

  await expect(refusal).rejects.toThrow('qa.repositories');
});

it('kills the process group when the caller aborts the launch', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const pidFile = join(worktree, 'descendant.pid');
  const abort = new AbortController();

  // The sleep ends on its own, so a failed assertion leaves no process behind for long.
  writeUser(settingsFor('sleep 10 & echo $! > descendant.pid; wait'));

  const refusal = applyQaSettings(
    launch(worktree),
    abort.signal,
    context(worktree) as never,
    declinedExec,
  );

  const outcome = refusal.catch((error: unknown) => error);

  onTestFinished(async () => {
    abort.abort();
    await outcome;
  });

  await vi.waitFor(() => {
    expect(readFileSync(pidFile, 'utf8')).toMatch(/\n$/);
  });

  const descendant = Number(readFileSync(pidFile, 'utf8'));

  abort.abort();
  expect(String(await outcome)).toContain('qa.repositories');

  await vi.waitFor(() => {
    expect(() => process.kill(descendant, 0)).toThrow('ESRCH');
  });
});

it('does not run the command for a launch the caller already aborted', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const marker = join(worktree, 'ran');

  writeUser(settingsFor(`sleep 0.3; touch ran; echo http://localhost:1`));

  const signal = AbortSignal.abort(new Error('Caller cancelled.'));

  const refusal = applyQaSettings(
    launch(worktree),
    signal,
    context(worktree) as never,
    declinedExec,
  );

  await expect(refusal).rejects.toBe(signal.reason);

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 700);
  });

  expect(existsSync(marker)).toBe(false);
});

it('gives the command no input, so a command that reads input ends at once', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser(settingsFor('cat; echo http://localhost:4100'));

  const resolved = await applyQaSettings(
    launch(worktree),
    undefined,
    context(worktree) as never,
    declinedExec,
    3000,
  );

  expect(resolved.url).toBe('http://localhost:4100');
});

it('settles at the deadline even when a process outside the group keeps the output open', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser(settingsFor('(setsid sleep 4 &); sleep 30'));

  const started = performance.now();

  const refusal = applyQaSettings(
    launch(worktree),
    undefined,
    context(worktree) as never,
    declinedExec,
    200,
  );

  await expect(refusal).rejects.toThrow('qa.repositories');
  expect(performance.now() - started).toBeLessThan(2000);
});

it.each([
  { timing: 'before spawn', alreadyAborted: true, spawnedCount: 0 },
  { timing: 'during spawn', alreadyAborted: false, spawnedCount: 1 },
])(
  'handles an unavailable shell when the launch aborts $timing',
  async ({ alreadyAborted, spawnedCount }) => {
    const { worktree, writeUser } = await fixture('https://github.com/sQVe/cape.git');
    const controller = new AbortController();
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    const state = { spawned: false };

    writeUser(settingsFor('echo http://localhost:1'));

    vi.mocked(spawn).mockImplementationOnce(() => {
      state.spawned = true;
      controller.abort();

      return child;
    });

    if (alreadyAborted) {
      controller.abort();
    }

    const refusal = applyQaSettings(
      launch(worktree),
      controller.signal,
      context(worktree) as never,
      declinedExec,
    );

    const expectedFailure = alreadyAborted
      ? (controller.signal.reason as Error)
      : /failed or timed out/u;

    await expect(refusal).rejects.toThrow(expectedFailure);

    // Node delivers a failed spawn's error after spawn returns, even when the caller has aborted.
    expect(() => {
      if (state.spawned) {
        const error = Object.assign(new Error('spawn sh ENOENT'), { code: 'ENOENT' });

        child.emit('error', error);
        child.emit('close', -2);
      }
    }).not.toThrow();

    expect(spawn).toHaveBeenCalledTimes(spawnedCount);
  },
);

it('refuses a urlCommand that cannot start', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const gitOnly = join(worktree, '..', 'git-only');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

  mkdirSync(gitOnly);
  symlinkSync(realGit, join(gitOnly, 'git'));
  writeUser(settingsFor('echo http://localhost:1'));
  vi.stubEnv('PATH', gitOnly);

  await expect(apply(launch(worktree), worktree)).rejects.toThrow('failed or timed out');
});
