import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { defaultSpawn, maximumStdoutBytes, maximumTotalBytes } from './process.js';

const scriptDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-process-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

const writeScript = async (directory: string, source: string) => {
  const script = join(directory, 'script.cjs');

  await writeFile(script, source);

  return script;
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

// Production signals a process group only on POSIX; Windows kills just the direct child.
const killsProcessGroups = process.platform !== 'win32';

// The script writes its own pid and a descendant's pid, then both wait for a minute.
// The rename makes the pid file appear only when it is complete.
const processTreeSource = (pidFile: string) =>
  "const { spawn } = require('node:child_process');\n" +
  "const { renameSync, writeFileSync } = require('node:fs');\n" +
  "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\n" +
  `writeFileSync(${JSON.stringify(`${pidFile}.partial`)}, JSON.stringify([process.pid, descendant.pid]));\n` +
  `renameSync(${JSON.stringify(`${pidFile}.partial`)}, ${JSON.stringify(pidFile)});\n` +
  'setTimeout(() => {}, 60000);\n';

const readProcessTree = async (pidFile: string): Promise<number[]> => {
  await vi.waitFor(() => readFile(pidFile), { timeout: 5_000, interval: 20 });
  const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];

  onTestFinished(() => {
    for (const pid of pids.filter(isRunning)) {
      process.kill(pid, 'SIGKILL');
    }
  });

  return pids;
};

const expectStopped = async (pids: number[]) => {
  await vi.waitFor(
    () => {
      expect(pids.filter(isRunning)).toEqual([]);
    },
    { timeout: 3_000, interval: 20 },
  );
};

it('returns the output, exit code, and byte counts of a finished process', async () => {
  const directory = await scriptDirectory();

  const script = await writeScript(
    directory,
    "process.stdout.write('hello');\nprocess.stderr.write('warn');\nprocess.exitCode = 3;\n",
  );

  expect(await defaultSpawn(script, [], { cwd: directory, timeoutMs: 10_000 })).toMatchObject({
    stdout: 'hello',
    stderr: 'warn',
    code: 3,
    timedOut: false,
    started: true,
    stdoutBytes: 5,
    stderrBytes: 4,
    stdoutTruncated: false,
  });
});

it('gives the process no stdin so a read ends at once', async () => {
  const directory = await scriptDirectory();

  const script = await writeScript(
    directory,
    "process.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write('end'));\n",
  );

  expect(await defaultSpawn(script, [], { cwd: directory, timeoutMs: 2_000 })).toMatchObject({
    stdout: 'end',
    code: 0,
    timedOut: false,
  });
});

it.for([
  ['at', 0, false],
  ['past', 200_000, true],
] as const)(
  'caps captured output and counts every byte when stdout ends %s its cap',
  async ([, extraBytes, stdoutTruncated]) => {
    const directory = await scriptDirectory();
    const stdoutLength = maximumStdoutBytes + extraBytes;
    const stderrLength = maximumTotalBytes * 3;

    // Small writes make the output arrive in many chunks that do not line up with the caps.
    const script = await writeScript(
      directory,
      'const write = (stream, character, length) => {\n' +
        '  for (let written = 0; written < length; written += 1000) {\n' +
        '    stream.write(character.repeat(Math.min(1000, length - written)));\n' +
        '  }\n' +
        '};\n' +
        `write(process.stdout, 'o', ${stdoutLength});\n` +
        `write(process.stderr, 'e', ${stderrLength});\n`,
    );

    const result = await defaultSpawn(script, [], { cwd: directory, timeoutMs: 10_000 });

    expect(result.stdout).toBe('o'.repeat(maximumStdoutBytes));
    expect(result.stderr).toBe('e'.repeat(maximumTotalBytes));

    expect(result).toMatchObject({
      stdoutBytes: stdoutLength,
      stderrBytes: stderrLength,
      stdoutTruncated,
    });
  },
);

it.skipIf(!killsProcessGroups)(
  'kills the process and its descendants when the timeout expires',
  async () => {
    const directory = await scriptDirectory();
    const pidFile = join(directory, 'pids.json');
    const script = await writeScript(directory, processTreeSource(pidFile));
    // vi.waitFor advances fake timers while it polls, so the timeout must outlast that wait.
    const timeoutMs = 60_000;
    const controller = new AbortController();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

    // The fake timeout never fires once real timers return, so a failed wait must abort the tree.
    onTestFinished(() => {
      controller.abort();
      vi.useRealTimers();
    });

    const pending = defaultSpawn(script, [], {
      cwd: directory,
      timeoutMs,
      signal: controller.signal,
    });

    const pids = await readProcessTree(pidFile);

    vi.advanceTimersByTime(timeoutMs);

    expect(await pending).toMatchObject({ code: null, timedOut: true });
    vi.useRealTimers();
    await expectStopped(pids);
  },
);

it.skipIf(!killsProcessGroups)(
  'kills the process and its descendants when the signal aborts',
  async () => {
    const directory = await scriptDirectory();
    const pidFile = join(directory, 'pids.json');
    const script = await writeScript(directory, processTreeSource(pidFile));
    const controller = new AbortController();

    onTestFinished(() => {
      controller.abort();
    });

    const pending = defaultSpawn(script, [], {
      cwd: directory,
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    const pids = await readProcessTree(pidFile);
    controller.abort();

    expect(await pending).toMatchObject({ code: null, timedOut: false });
    await expectStopped(pids);
  },
);

it('stops at once when the signal aborted before the run', async () => {
  const directory = await scriptDirectory();
  const script = await writeScript(directory, 'setTimeout(() => {}, 60000);\n');
  const controller = new AbortController();

  controller.abort();

  expect(
    await defaultSpawn(script, [], { cwd: directory, timeoutMs: 2_000, signal: controller.signal }),
  ).toMatchObject({ code: null, timedOut: false });
});

it('sends no kill after a finished run when its timeout would have expired', async () => {
  const directory = await scriptDirectory();
  const script = await writeScript(directory, "process.stdout.write('done');\n");
  const timeoutMs = 10_000;

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const result = await defaultSpawn(script, [], { cwd: directory, timeoutMs });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

  onTestFinished(() => {
    kill.mockRestore();
  });

  vi.advanceTimersByTime(timeoutMs);

  expect(result).toMatchObject({ code: 0, timedOut: false });
  expect(kill).not.toHaveBeenCalled();
});

it('reports a spawn error as an unstarted run without an exit code', async () => {
  const directory = await scriptDirectory();
  const script = await writeScript(directory, '');

  const result = await defaultSpawn(script, [], {
    cwd: join(directory, 'missing'),
    timeoutMs: 10_000,
  });

  expect(result).toMatchObject({ code: null, started: false, timedOut: false });
  expect(result.stderr).toContain('ENOENT');
});
