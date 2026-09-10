import { fork } from 'node:child_process';
import filesystem, {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { guardToolCall } from './guard.js';
import { createEvidenceStore, tddGateStatus } from './state.js';

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-shared-gate-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const cwd = join(root, 'worktree');

  await mkdir(join(cwd, 'src'), { recursive: true });
  await symlink(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'vite.config.ts'), 'export default {};');
  await writeFile(join(cwd, 'src/value.ts'), '// Original comment.\nexport const value = 1;\n');

  return { root, cwd };
};

const event = (path: string): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'shared-gate',
  toolName: 'edit',
  input: {
    path,
    edits: [{ oldText: '// Original comment.', newText: '// Revised comment.' }],
  },
});

it('reads gate switches from disk in both directions across stores', async () => {
  const { cwd } = await fixture();
  const coordinator = createEvidenceStore();
  const worker = createEvidenceStore();

  expect((await coordinator.read(cwd)).notice).toBeUndefined();
  await worker.setGate(cwd, 'off');

  const diskBeforeRead = await readFile(join(cwd, '.tau/state.json'), 'utf8');

  expect(await tddGateStatus(cwd)).toContain('TDD gate off');
  expect((await coordinator.read(cwd)).notice).toBe(await tddGateStatus(cwd));
  expect((await coordinator.read(cwd)).implementationAllowed).toBe(true);
  expect(await guardToolCall(event('src/value.ts'), cwd, coordinator)).toBeUndefined();
  expect(await guardToolCall(event('src/value.ts'), cwd, worker)).toBeUndefined();
  expect(await readFile(join(cwd, '.tau/state.json'), 'utf8')).toBe(diskBeforeRead);

  const reloaded = createEvidenceStore();

  expect(await guardToolCall(event('src/value.ts'), cwd, reloaded)).toBeUndefined();
  await coordinator.setGate(cwd, 'off');
  expect(await guardToolCall(event('src/value.ts'), cwd, coordinator)).toBeUndefined();

  await worker.setGate(cwd, 'on');

  expect(await tddGateStatus(cwd)).toBeUndefined();
  expect((await coordinator.read(cwd)).implementationAllowed).toBe(false);
  expect((await guardToolCall(event('src/value.ts'), cwd, coordinator))?.block).toBe(true);
  expect((await guardToolCall(event('src/value.ts'), cwd, worker))?.block).toBe(true);
});

it('allows outside writes but protects configuration while the gate is off', async () => {
  const { root, cwd } = await fixture();
  const store = createEvidenceStore();

  await store.setGate(cwd, 'off');

  const outside = join(root, 'completion.md');
  const result = await guardToolCall(
    { ...event(outside), toolName: 'write', input: { path: outside, content: '# Completion\n' } },
    cwd,
    store,
  );

  expect((await store.read(cwd)).notice).toContain('TDD gate off');
  expect(result).toBeUndefined();
  expect((await guardToolCall(event('package.json'), cwd, store))?.block).toBe(true);
  expect((await guardToolCall(event('.tau/state.json'), cwd, store))?.block).toBe(true);
});

it('preserves gate switches and active behavior across stale stores', async () => {
  const { cwd } = await fixture();
  const coordinator = createEvidenceStore();
  const worker = createEvidenceStore();

  await writeFile(
    join(cwd, 'existing.test.ts'),
    "import { it, expect } from 'vitest'; it('existing behavior', () => expect(1).toBe(1));",
  );
  await coordinator.read(cwd);
  await worker.setGate(cwd, 'off');
  expect(await tddGateStatus(cwd)).toContain('TDD gate off');

  const result = await coordinator.run(
    cwd,
    {
      behavior: 'existing behavior',
      testFullName: 'existing behavior',
      files: ['existing.test.ts'],
    },
    'focused',
  );

  expect(result.kind).toBe('pass');
  expect(result.phase).toBe('locked');
  expect(await tddGateStatus(cwd)).toContain('TDD gate off');
  expect(result.implementationAllowed).toBe(true);
  expect((await worker.read(cwd)).notice).toContain('TDD gate off');

  await worker.setGate(cwd, 'off');

  expect((await createEvidenceStore().read(cwd)).evidence.active).toEqual(result.evidence.active);
}, 30_000);

it('uses the same effective permission and status without a runner', async () => {
  const { cwd } = await fixture();

  await rm(join(cwd, 'node_modules'));

  const store = createEvidenceStore();
  const state = await store.read(cwd);

  expect(state.implementationAllowed).toBe(true);
  expect(await tddGateStatus(cwd)).toBe(state.notice);
  expect(await guardToolCall(event('src/value.ts'), cwd, store)).toBeUndefined();
  expect((await guardToolCall(event('package.json'), cwd, store))?.block).toBe(true);
  await expect(readFile(join(cwd, '.tau/state.json'))).rejects.toThrow(/ENOENT/);
});

it('fails closed when previously loaded evidence becomes unreadable', async () => {
  const { cwd } = await fixture();
  const store = createEvidenceStore();

  await store.setGate(cwd, 'off');
  await writeFile(join(cwd, '.tau/state.json'), '{broken');

  await expect(store.read(cwd)).rejects.toThrow('Unreadable test evidence');
  await expect(store.setGate(cwd, 'on')).rejects.toThrow('Unreadable test evidence');
  expect(await tddGateStatus(cwd)).toContain('status unknown');
  expect(await readFile(join(cwd, '.tau/state.json'), 'utf8')).toBe('{broken');
  expect(await readdir(join(cwd, '.tau'))).toEqual(['state.json']);
});

const childStore = async (
  root: string,
  cwd: string,
  operation: 'toggle' | 'run',
  pause: boolean,
) => {
  const script = join(root, `${operation}.mjs`);
  const piRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));

  await writeFile(
    script,
    `
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { createJiti } from ${JSON.stringify(piRequire.resolve('jiti'))};

const originalRename = filesystem.rename;
const originalMkdir = filesystem.mkdir;
filesystem.mkdir = async (path, ...arguments_) => {
  if (String(path).endsWith('/state.lock')) process.send('locking');
  return originalMkdir(path, ...arguments_);
};
filesystem.rename = async (...arguments_) => {
  process.send('saving');
  if (${pause}) await once(process, 'message');
  return originalRename(...arguments_);
};
syncBuiltinESMExports();

const { createEvidenceStore } = await createJiti(import.meta.url).import(${JSON.stringify(resolve(import.meta.dirname, 'state.ts'))});
const store = createEvidenceStore();
const cwd = ${JSON.stringify(cwd)};
await store.read(cwd);
process.send('ready');
await once(process, 'message');
try {
  const result = ${
    operation === 'toggle'
      ? "await store.setGate(cwd, 'off')"
      : "await store.run(cwd, { behavior: 'concurrent', testFullName: 'concurrent', files: ['concurrent.test.ts'] }, 'focused')"
  };
  process.send({ result });
} catch (error) {
  process.send({ error: String(error) });
}
process.disconnect();
`,
  );

  const child = fork(script, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages: unknown[] = [];
  let errors = '';

  child.on('message', (message) => messages.push(message));
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => {
      resolveExit();
    });
  });
  onTestFinished(async () => {
    if (child.exitCode === null) {
      child.kill();
    }

    await exited;
  });

  await expect.poll(() => messages, { timeout: 15_000 }).toContain('ready');

  return { child, messages, exited, errors: () => errors };
};

it('serializes cross-process updates through canonical worktree aliases without losing RED', async () => {
  const { root, cwd } = await fixture();
  const alias = join(root, 'alias');

  await symlink(cwd, alias, 'dir');
  await writeFile(
    join(cwd, 'concurrent.test.ts'),
    "import { it, expect } from 'vitest'; it('concurrent', () => expect(1).toBe(2));",
  );

  const toggle = await childStore(root, cwd, 'toggle', true);
  const run = await childStore(root, alias, 'run', false);

  toggle.child.send('start');
  await expect.poll(() => toggle.messages, { timeout: 10_000 }).toContain('saving');
  run.child.send('start');

  // The old writer finishes while the first rename is paused. A locked writer waits instead.
  await expect
    .poll(
      () =>
        run.messages.some(
          (message) => message === 'locking' || (typeof message === 'object' && message !== null),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  toggle.child.send('release');
  await Promise.all([toggle.exited, run.exited]);

  expect(toggle.errors()).toBe('');
  expect(run.errors()).toBe('');
  expect(toggle.messages.at(-1)).toHaveProperty('result');
  expect(run.messages.at(-1)).toHaveProperty('result.kind', 'fail');

  const state = await createEvidenceStore().read(cwd);
  const aliasedState = await createEvidenceStore().read(alias);

  expect(state).toEqual(aliasedState);
  expect(state.phase).toBe('red');
  expect(state.evidence.reds).toHaveLength(1);
  expect(state.evidence.proven).toEqual([{ file: 'concurrent.test.ts', fullname: 'concurrent' }]);
  expect(state.notice).toContain('TDD gate off');
  expect(await readdir(join(cwd, '.tau'))).toEqual(['state.json']);
}, 45_000);

it('does not replace an existing lock or follow state symlinks', async () => {
  const { root, cwd } = await fixture();
  const store = createEvidenceStore();

  await store.setGate(cwd, 'on');

  const path = join(cwd, '.tau/state.json');
  const original = await readFile(path, 'utf8');
  const lock = join(cwd, '.tau/state.lock');

  await mkdir(lock);
  await expect(store.setGate(cwd, 'off')).rejects.toThrow(/lock/i);
  expect(await readFile(path, 'utf8')).toBe(original);
  await rm(lock, { recursive: true });
  await store.setGate(cwd, 'on');

  const outside = join(root, 'outside.json');

  await writeFile(outside, original);
  await rm(path);
  await symlink(outside, path);
  await expect(store.setGate(cwd, 'off')).rejects.toThrow(/symlink/i);
  await expect(store.read(cwd)).rejects.toThrow(/symlink/i);
  expect(await readFile(outside, 'utf8')).toBe(original);

  await rm(join(cwd, '.tau'), { recursive: true });
  await symlink(root, join(cwd, '.tau'), 'dir');
  await expect(store.setGate(cwd, 'off')).rejects.toThrow(/symlink/i);
  await expect(store.read(cwd)).rejects.toThrow(/symlink/i);
}, 15_000);

it('preserves disk state and releases the lock after a failed save', async () => {
  const { cwd } = await fixture();
  const store = createEvidenceStore();

  await store.setGate(cwd, 'on');

  const rename = vi.spyOn(filesystem, 'rename').mockRejectedValueOnce(new Error('save failed'));
  syncBuiltinESMExports();
  onTestFinished(() => {
    rename.mockRestore();
    syncBuiltinESMExports();
  });

  await expect(store.setGate(cwd, 'off')).rejects.toThrow('save failed');
  expect((await store.read(cwd)).notice).toBeUndefined();
  expect(await readdir(join(cwd, '.tau'))).toEqual(['state.json']);
  await store.setGate(cwd, 'off');
  expect((await store.read(cwd)).notice).toContain('TDD gate off');
});
