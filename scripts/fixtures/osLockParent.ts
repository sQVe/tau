import { spawn } from 'node:child_process';

// argv: <exit|wait> <command> [arguments...]
const [mode, command, ...commandArguments] = process.argv.slice(2);

const refuseUsage: (problem: string) => never = (problem) => {
  process.stderr.write(
    `${problem}\nUsage: node osLockParent.ts <exit|wait> <command> [arguments...]\n`,
  );

  return process.exit(64);
};

if (command === undefined) {
  refuseUsage('A parent needs a command to start.');
}

if (mode !== 'exit' && mode !== 'wait') {
  refuseUsage('A parent runs in exit or wait mode.');
}

// A detached holder leaves the parent's process group, so the parent's exit cannot take it down.
// A waiting parent keeps its holder in the same group, so a signal aimed at the parent is the only
// thing that could end it.
const holder = spawn(command, commandArguments, {
  detached: mode === 'exit',
  stdio: 'ignore',
});

holder.unref();
process.stdout.write(`${String(holder.pid)}\n`);

if (mode === 'wait') {
  setInterval(() => undefined, 1_000);
}
