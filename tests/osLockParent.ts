import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const usage = 'Usage: node osLockParent.ts <abandon|exit|wait> <marker> <command> [arguments...]';

const readinessPollMilliseconds = 20;
const readinessTimeoutMilliseconds = 10_000;

const [mode, markerPath, command, ...commandArguments] = process.argv.slice(2);

const refuseUsage: (problem: string) => never = (problem) => {
  process.stderr.write(`${problem}\n${usage}\n`);
  process.exit(64);
};

if (command === undefined || markerPath === undefined) {
  refuseUsage('A parent needs a marker path and a command to start.');
}

if (mode !== 'abandon' && mode !== 'exit' && mode !== 'wait') {
  refuseUsage('A parent runs in abandon, exit, or wait mode.');
}

const holder = spawn(command, commandArguments, {
  detached: mode === 'exit',
  stdio: 'ignore',
});

holder.unref();

if (mode !== 'abandon') {
  process.stdout.write(`${String(holder.pid)}\n`);
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

    if (holder.pid === undefined || holder.exitCode !== null) {
      return false;
    }

    await sleep(readinessPollMilliseconds);
  }

  return false;
};

if (!(await holderIsReady())) {
  process.stderr.write('The holder did not take the lock.\n');
  process.exit(70);
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
