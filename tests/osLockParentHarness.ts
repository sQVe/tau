import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { errorMessage } from '../src/errors.ts';

const usage =
  'Usage: node osLockParentHarness.ts <abandon|exit|wait> <marker> <holder-pid-file> <command> [arguments...]';

const readinessPollMilliseconds = 20;
const readinessTimeoutMilliseconds = 10_000;
const holderFailureExitCode = 70;

const [mode, markerPath, holderPidPath, command, ...commandArguments] = process.argv.slice(2);

const refuseUsage: (problem: string) => never = (problem) => {
  process.stderr.write(`${problem}\n${usage}\n`);
  process.exit(64);
};

const refuseHolder: (problem: string) => never = (problem) => {
  process.stderr.write(`${problem}\n`);
  process.exit(holderFailureExitCode);
};

if (command === undefined || holderPidPath === undefined || markerPath === undefined) {
  refuseUsage('A parent needs a marker path, a holder process ID file, and a command to start.');
}

if (mode !== 'abandon' && mode !== 'exit' && mode !== 'wait') {
  refuseUsage('A parent runs in abandon, exit, or wait mode.');
}

// Only wait mode leaves the holder in the parent group, so the other modes outlive a killed parent.
const holder = spawn(command, commandArguments, {
  detached: mode !== 'wait',
  stdio: 'ignore',
});

holder.unref();

const holderPid = holder.pid;

// A program that spawn cannot find has no process ID, so a missing ID also reports a failed start.
if (holderPid === undefined) {
  refuseHolder(`The holder could not start: ${command}`);
}

// The file reaches the caller before the printed ID does, so a caller that never reads the print
// still learns which detached holder to stop.
try {
  await writeFile(holderPidPath, `${String(holderPid)}\n`);
} catch (error) {
  holder.kill('SIGKILL');

  refuseHolder(
    `The holder process ID could not be recorded at ${holderPidPath}: ${errorMessage(error)}`,
  );
}

if (mode !== 'abandon') {
  process.stdout.write(`${String(holderPid)}\n`);
}

const markerExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

const holderIsReady = async (): Promise<boolean> => {
  const deadline = Date.now() + readinessTimeoutMilliseconds;

  while (Date.now() < deadline) {
    if (await markerExists(markerPath)) {
      return true;
    }

    if (holder.exitCode !== null) {
      return false;
    }

    await sleep(readinessPollMilliseconds);
  }

  return false;
};

if (!(await holderIsReady())) {
  process.stderr.write('The holder did not take the lock.\n');
  process.exit(holderFailureExitCode);
}

if (mode === 'abandon') {
  process.exit(0);
}

if (mode === 'wait') {
  setInterval(() => undefined, 1_000);
} else {
  // The test closes this process's stdin, so it can read the lock state before the parent exits.
  process.stdin.resume();

  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
  });
}
