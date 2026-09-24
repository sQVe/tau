import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it, onTestFinished } from 'vitest';

import { fixtureLoadout } from './fixtures/loadout.js';
import { publish, readSuccessor, validateTask } from './records.js';

it('allows only one production successor claim across competing processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-claims-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const directory = join(root, 'source');
  mkdirSync(directory);
  const task = validateTask({
    version: 1,
    taskId: 'source',
    task: 'Inspect.',
    parentSession: join(root, 'parent.jsonl'),
    parentSessionId: 'parent',
    nativeSessionId: 'native',
    nativeSessionFile: join(directory, 'native.jsonl'),
    createdAt: 1000,
    deadline: 20000,
    cancellationBudget: 1000,
    monotonicDeadline: 20000,
    loadout: fixtureLoadout(root),
  });
  publish(directory, 'task.json', task);
  const contenders = ['first', 'second'].map((id) => {
    const next = join(root, id);
    mkdirSync(next);
    publish(next, 'task.json', { ...task, taskId: id, predecessorTaskId: task.taskId });
    const source = fileURLToPath(new URL('./records.ts', import.meta.url));
    const program = `import { createJiti } from 'jiti';
const loader = createJiti(process.cwd() + '/claim-test.mjs');
const { claimSuccessor, readTask } = await loader.import(${JSON.stringify(source)});
process.stdout.write('ready\\n');
process.stdin.once('data', () => {
  try { claimSuccessor(${JSON.stringify(directory)}, readTask(${JSON.stringify(next)})); process.exit(0); }
  catch { process.exit(1); }
});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    onTestFinished(() => {
      child.kill('SIGTERM');
    });
    const ready = Promise.withResolvers<undefined>();
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();

      if (output.includes('ready\n')) {
        ready.resolve(undefined);
      }
    });
    child.once('exit', () => {
      ready.reject(new Error('Claim process exited before readiness.'));
    });

    return { child, ready: ready.promise, exited: once(child, 'exit') };
  });
  await Promise.all(contenders.map((contender) => contender.ready));

  for (const contender of contenders) {
    contender.child.stdin.end('claim');
  }

  const exits = await Promise.all(contenders.map((contender) => contender.exited));

  expect(
    exits
      .map(([code]) => (typeof code === 'number' ? code : -1))
      .toSorted((left, right) => left - right),
  ).toEqual([0, 1]);
  expect(['first', 'second']).toContain(readSuccessor(directory)?.successorTaskId);
}, 15000);
