import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it, onTestFinished } from 'vitest';

import { admissionDirectory, inheritedInstructions, reserveTask } from './admission.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { publish, recordEvent } from './records.js';
import type { Task } from './types.js';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-admission-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const task = (taskId: string, parentTaskId?: string) => ({
    version: 1 as const,
    taskId,
    task: 'Assigned work.',
    parentSession: join(root, parentTaskId ? `${parentTaskId}.jsonl` : 'root.jsonl'),
    parentSessionId: parentTaskId ?? 'root',
    ownerId: 'owner',
    nativeSessionId: `${taskId}-native`,
    nativeSessionFile: join(root, `${taskId}.jsonl`),
    createdAt: 1000,
    deadline: 61000,
    cancellationBudget: 5000,
    loadout: fixtureLoadout(root),
    tree: {
      rootSession: join(root, 'root.jsonl'),
      rootSessionId: 'root',
      ...(parentTaskId ? { parentTaskId } : {}),
      monotonicDeadline: 61000,
    },
  });
  const save = (value: Task) => {
    const directory = join(root, value.taskId);
    mkdirSync(directory);
    publish(directory, 'task.json', value);

    return directory;
  };

  return { root, task, save };
};

it('reserves one shared tree cap and retains uncertain work without double release', () => {
  const { root, task, save } = setup();
  const parent = task('parent');
  const child = task('child', 'parent');
  child.parentSessionId = parent.nativeSessionId;
  child.tree.monotonicDeadline = 56000;
  child.loadout.instructions = `${inheritedInstructions(parent)}Read the fixture.`;
  reserveTask(root, parent, 2);
  const parentDirectory = save(parent);
  reserveTask(root, child, 99);
  const childDirectory = save(child);

  expect(() => {
    reserveTask(root, task('overflow'), 99);
  }).toThrow('capacity full');
  recordEvent(childDirectory, child.taskId, 'settled', 'Turn ended.', true);
  expect(() => {
    reserveTask(root, task('still-full'));
  }).toThrow('capacity full');
  recordEvent(childDirectory, child.taskId, 'cleanup', 'Confirmed stopped.', true);
  reserveTask(root, task('replacement'));
  expect(() => {
    reserveTask(root, task('overflow-again'));
  }).toThrow('capacity full');
  expect(() => {
    reserveTask(root, child);
  }).toThrow('already reserved');
  recordEvent(parentDirectory, parent.taskId, 'cleanup', 'Unconfirmed.', false);
  expect(() => {
    reserveTask(root, task('uncertain'));
  }).toThrow('capacity full');
});

it('refuses a held or abandoned admission lock without waiting or reclaiming it', () => {
  const { root, task } = setup();
  const request = task('blocked');
  const directory = admissionDirectory(root, request.tree);
  mkdirSync(join(directory, 'lock'), { recursive: true });

  expect(() => {
    reserveTask(root, request);
  }).toThrow('Admission busy');
  expect(existsSync(join(directory, 'lock'))).toBe(true);
  expect(existsSync(join(directory, 'blocked.json'))).toBe(false);
});

it('reports actionable orphan reservations and distinguishes initial capacity errors', () => {
  const { root, task } = setup();
  const orphan = task('orphan');

  expect(() => {
    reserveTask(root, orphan, 0);
  }).toThrow('Invalid initial root capacity');
  reserveTask(root, orphan, 1);
  expect(() => {
    reserveTask(root, task('blocked'));
  }).toThrow(admissionDirectory(root, orphan.tree));
  expect(() => {
    reserveTask(root, task('blocked'));
  }).toThrow(join(root, orphan.taskId));
  const directory = admissionDirectory(root, orphan.tree);
  writeFileSync(join(directory, 'policy.json'), '{');
  expect(() => {
    reserveTask(root, task('corrupt-policy'));
  }).toThrow(`Invalid saved root admission policy at ${directory}`);
  writeFileSync(join(directory, 'policy.json'), JSON.stringify({ capacity: 1 }));
  expect(() => {
    reserveTask(root, task('invalid-policy'));
  }).toThrow('Invalid saved root admission policy');
});

it('rejects descendant authority changes and never lets descendants configure the cap', () => {
  const { root, task, save } = setup();
  const parent = task('parent');
  parent.loadout.tools.push('subagent');
  const child = task('child', 'parent');
  child.parentSessionId = parent.nativeSessionId;
  child.tree.monotonicDeadline = 56000;
  child.loadout = { ...parent.loadout, instructions: `${inheritedInstructions(parent)}Read.` };

  expect(() => {
    reserveTask(root, child, 256);
  }).toThrow('descendant cannot configure');
  reserveTask(root, parent);
  save(parent);
  for (const change of [
    { model: 'different/model' },
    { tools: [...child.loadout.tools, 'new-authority'] },
    { instructions: 'Forget the parent task.' },
  ]) {
    expect(() => {
      reserveTask(root, { ...child, loadout: { ...child.loadout, ...change } });
    }).toThrow('inherited settings');
  }
  expect(() => {
    reserveTask(root, { ...child, tree: { ...child.tree, monotonicDeadline: 56001 } });
  }).toThrow('deadline');
  reserveTask(root, child, 256);
});

it('atomically admits competing root and descendant processes into one remaining slot', async () => {
  const { root, task, save } = setup();
  const parent = task('parent');
  reserveTask(root, parent, 2);
  save(parent);
  const child = task('child', parent.taskId);
  child.parentSessionId = parent.nativeSessionId;
  child.tree.monotonicDeadline = 56000;
  child.loadout.instructions = `${inheritedInstructions(parent)}Read.`;
  const contenders = [task('root-request'), child].map((request) => {
    const source = fileURLToPath(new URL('./admission.ts', import.meta.url));
    const program = `import { createJiti } from 'jiti';
const loader = createJiti(process.cwd() + '/admission-test.mjs');
const { reserveTask } = await loader.import(${JSON.stringify(source)});
process.stdout.write('ready\\n');
process.stdin.once('data', () => {
  try { reserveTask(${JSON.stringify(root)}, ${JSON.stringify(request)}, 256); process.exit(0); }
  catch (error) { process.stderr.write(String(error)); process.exit(1); }
});`;
    const contender = spawn(process.execPath, ['--input-type=module', '-e', program], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    onTestFinished(() => {
      contender.kill('SIGTERM');
    });
    const ready = Promise.withResolvers<undefined>();
    let output = '';
    let errors = '';
    contender.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.includes('ready\n')) {
        ready.resolve(undefined);
      }
    });
    contender.stderr.on('data', (data: Buffer) => {
      errors += data.toString();
    });
    contender.once('exit', () => {
      ready.reject(new Error(`Admission process exited before readiness: ${errors}`));
    });

    return {
      process: contender,
      ready: ready.promise,
      exited: once(contender, 'exit'),
      errors: () => errors,
    };
  });
  await Promise.all(contenders.map((contender) => contender.ready));
  for (const contender of contenders) {
    contender.process.stdin.end('reserve');
  }
  const exits = await Promise.all(contenders.map((contender) => contender.exited));

  expect(
    exits
      .map(([code]) => (typeof code === 'number' ? code : -1))
      .toSorted((left, right) => left - right),
  ).toEqual([0, 1]);
  expect(contenders.map((contender) => contender.errors()).join(' ')).toMatch(
    /capacity full|Admission busy/,
  );
  expect(
    readdirSync(admissionDirectory(root, parent.tree)).filter(
      (name) => name.endsWith('.json') && name !== 'policy.json',
    ),
  ).toHaveLength(2);
  expect(() => {
    reserveTask(root, task('later-root'));
  }).toThrow('capacity full');
}, 15000);
