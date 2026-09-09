import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { guardToolCall } from './guard.js';
import type { createEvidenceStore } from './state.js';
import type { Phase } from './types.js';

const phases: Phase[] = ['locked', 'red', 'green', 'verified'];
const createStore = (phase: Phase, notice?: string) => ({
  read: vi.fn<ReturnType<typeof createEvidenceStore>['read']>(() =>
    Promise.resolve({
      phase,
      notice,
      implementationAllowed: phase === 'red' || phase === 'green',
      focusedPassValid: phase === 'green' || phase === 'verified',
      fullPassValid: phase === 'verified',
      staleSinceRed: [],
      evidence: {
        active: {
          behavior: 'required behavior',
          testFullName: 'required',
          files: ['value.test.ts'],
        },
        reds: [],
        phase,
        verifiedTree: null,
        proven: [],
        gateOff: null,
      },
    }),
  ),
});
const makeEvent = (toolName: string, input: Record<string, unknown>): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'call-1',
  toolName,
  input,
});

it('allows an empty new production file before RED without allowing implementation or erasure', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-guard-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'src'));
  const store = createStore('locked');
  const write = (path: string, content: string) =>
    guardToolCall(makeEvent('write', { path, content }), cwd, store);
  expect(await write('src/new.ts', '')).toBeUndefined();
  expect((await write('src/new.ts', 'export const value = 1;'))?.block).toBe(true);
  await writeFile(join(cwd, 'src/existing.ts'), 'export const value = 1;');
  expect((await write('src/existing.ts', ''))?.block).toBe(true);
  expect((await write('vitest.config.ts', ''))?.block).toBe(true);
  await symlink('../vitest.config.ts', join(cwd, 'src/config.ts'));
  expect((await write('src/config.ts', ''))?.block).toBe(true);
});

it('protects both symlink spellings and configuration targets', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-guard-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'shared-config.ts'), 'export default {};');
  await symlink('shared-config.ts', join(cwd, 'vitest.config.ts'));
  await writeFile(join(cwd, 'vite.config.ts'), 'export default {};');
  await symlink('vite.config.ts', join(cwd, 'alias.ts'));
  for (const path of ['vitest.config.ts', 'alias.ts']) {
    for (const tool of ['write', 'edit']) {
      expect(
        (await guardToolCall(makeEvent(tool, { path }), cwd, createStore('green')))?.block,
      ).toBe(true);
    }
  }
});

it.each(phases)('allows test writes, including colocated tests, in %s', async (phase) => {
  for (const path of ['value.test.ts', 'src/value.test.ts', 'src/value.spec.tsx']) {
    for (const tool of ['write', 'edit']) {
      expect(
        await guardToolCall(makeEvent(tool, { path }), '/repo', createStore(phase)),
      ).toBeUndefined();
    }
  }
});

it.each(phases)('allows production writes while no test runner resolves in %s', async (phase) => {
  const store = createStore(phase, 'no test runner resolves from /repo');
  for (const tool of ['write', 'edit']) {
    expect(
      await guardToolCall(makeEvent(tool, { path: 'src/value.ts' }), '/repo', store),
    ).toBeUndefined();
  }
});

it.each(phases)('keeps protected paths blocked with no runner in %s', async (phase) => {
  const store = createStore(phase, 'no test runner resolves from /repo');
  for (const [path, next] of [
    ['.tau/state.json', 'Choose an unprotected test file with ls {"path":"."}'],
    ['package.json', 'Choose an unprotected test file with ls {"path":"."}'],
    ['@package.json', 'List literal worktree paths with ls {"path":"."}'],
    ['~/value.ts', 'List literal worktree paths with ls {"path":"."}'],
  ]) {
    const result = await guardToolCall(makeEvent('write', { path }), '/repo', store);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(next);
  }
});

it.each(phases)('allows writes outside the production globs in %s', async (phase) => {
  for (const path of ['README.md', 'docs/guide.md', 'scripts/check.sh', 'src/value.css']) {
    for (const tool of ['write', 'edit']) {
      expect(
        await guardToolCall(makeEvent(tool, { path }), '/repo', createStore(phase)),
      ).toBeUndefined();
    }
  }
});

it.each(phases)('blocks evidence and verification configuration writes in %s', async (phase) => {
  for (const path of [
    '.tau/state.json',
    '.tau/guard.test.ts',
    '.tau',
    'vite.config.ts',
    'vitest.config.ts',
    'vitest.config.mts',
    'package.json',
    'src/../package.json',
  ]) {
    for (const tool of ['write', 'edit']) {
      const result = await guardToolCall(makeEvent(tool, { path }), '/repo', createStore(phase));
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain(path);
      expect(result?.reason).toContain(phase);
      expect(result?.reason).toContain('required behavior');
      expect(result?.reason).toContain('Choose an unprotected test file with ls {"path":"."}');
    }
  }
});

it.each(phases)('blocks unrecognized tools carrying path arguments in %s', async (phase) => {
  for (const input of [
    ...[
      'path',
      'file_path',
      'filePath',
      'file',
      'target',
      'destination',
      'directory',
      'filename',
    ].map((key) => ({ [key]: 'src/value.test.ts' })),
    { files: ['src/value.ts'] },
    { changes: [{ targetPath: 'src/value.ts' }] },
  ]) {
    const result = await guardToolCall(makeEvent('mcp_patch', input), '/repo', createStore(phase));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('src/value');
    expect(result?.reason).toContain(phase);
    expect(result?.reason).toContain('required behavior');
    expect(result?.reason).toContain('unrecognized tool mcp_patch');
    expect(result?.reason).toContain('with write using a literal path and the intended content');
  }
});

it.each(phases)(
  'passes read-only tools, shell commands, questions, and commit hooks through in %s',
  async (phase) => {
    const store = createStore(phase);
    for (const tool of [
      'read',
      'bash',
      'grep',
      'find',
      'ls',
      'run_tests',
      'commit',
      'ask_user_question',
      'web_search',
      'source_check',
      'fetch_content',
      'get_search_content',
    ]) {
      expect(
        await guardToolCall(
          makeEvent(tool, {
            path: 'package.json',
            files: ['src/value.ts'],
            command: 'echo changed > src/value.ts',
          }),
          '/repo',
          store,
        ),
      ).toBeUndefined();
    }
    expect(store.read).not.toHaveBeenCalled();
  },
);

it.each(phases)('blocks unrecognized tools without path arguments in %s', async (phase) => {
  for (const input of [
    { patch: '*** Update File: src/value.ts\n@@\n-old\n+new' },
    { uri: 'file:///repo/src/value.ts', content: 'changed' },
    { page_id: 'value', content: 'changed' },
  ]) {
    const result = await guardToolCall(
      makeEvent('apply_patch', input),
      '/repo',
      createStore(phase),
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(phase);
    expect(result?.reason).toContain('required behavior');
    expect(result?.reason).toContain('unrecognized tool apply_patch');
    expect(result?.reason).toContain('with write using a literal path and the intended content');
  }
});

it.each(phases)('leaves paths outside the worktree ungated in %s', async (phase) => {
  for (const path of [
    '../outside.ts',
    '/outside.ts',
    '/repo-sibling/src/value.ts',
    'src/../../outside.ts',
    '..\\outside.ts',
    '/home/user/.pi/agent/settings.json',
  ]) {
    for (const tool of ['write', 'edit']) {
      expect(
        await guardToolCall(makeEvent(tool, { path }), '/repo', createStore(phase)),
      ).toBeUndefined();
    }
  }
});

it('blocks backslash-separated protected paths', async () => {
  const result = await guardToolCall(
    makeEvent('write', { path: '.tau\\state.json' }),
    '/repo',
    createStore('red'),
  );
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain('Choose an unprotected test file with ls {"path":"."}');
});

it.each(phases)('uses the stored implementation decision in %s', async (phase) => {
  const store = createStore(phase);
  const result = await guardToolCall(
    makeEvent('write', { path: '/repo/src/value.ts' }),
    '/repo',
    store,
  );
  expect(result?.block === true).toBe(phase !== 'red' && phase !== 'green');
  expect(store.read).toHaveBeenCalledExactlyOnceWith('/repo');
});

it('checks the actual built-in target even when another path argument comes first', async () => {
  for (const tool of ['write', 'edit']) {
    const result = await guardToolCall(
      makeEvent(tool, { file: 'value.test.ts', path: 'package.json' }),
      '/repo',
      createStore('red'),
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('package.json');
  }
});

it('requires literal paths instead of Pi aliases that can bypass path checks', async () => {
  for (const path of [
    '@package.json',
    '@.tau/state.test.ts',
    '~/outside.test.ts',
    '@../outside.test.ts',
  ]) {
    const result = await guardToolCall(makeEvent('write', { path }), '/repo', createStore('red'));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(path);
    expect(result?.reason).toContain('List literal worktree paths with ls {"path":"."}');
  }
});

it.each([
  [
    'locked',
    'Prove RED with run_tests {"behavior":"required behavior","testFullName":"required","files":["value.test.ts"],"scope":"focused"}',
  ],
  [
    'verified',
    'Start the next behavior with write using path "src/value.test.ts" and content that tests the missing behavior',
  ],
] as const)('gives an actionable next step in %s', async (phase, next) => {
  const result = await guardToolCall(
    makeEvent('write', { path: 'src/value.ts' }),
    '/repo',
    createStore(phase),
  );
  expect(result?.reason).toBe(
    `Blocked src/value.ts in phase ${phase}, active behavior: required behavior. ${next}.`,
  );
});

it('requests a failing test when no behavior is active', async () => {
  const store = createStore('locked');
  const state = await store.read('/repo');
  store.read.mockResolvedValue({ ...state, evidence: { ...state.evidence, active: null } });
  const result = await guardToolCall(makeEvent('write', { path: 'src/value.ts' }), '/repo', store);
  expect(result?.reason).toBe(
    'Blocked src/value.ts in phase locked, active behavior: none. Write a failing test with write using path "src/value.test.ts" and content that checks the missing behavior.',
  );
});

it('gates a production file addressed through a symlinked spelling of the worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-guard-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  const link = join(root, 'link');
  await mkdir(join(real, 'src'), { recursive: true });
  await symlink(real, link, 'dir');
  for (const [cwd, path] of [
    [link, join(real, 'src/value.ts')],
    [real, join(link, 'src/value.ts')],
    [real, join(link, 'src/new/value.ts')],
  ] as const) {
    const result = await guardToolCall(makeEvent('write', { path }), cwd, createStore('locked'));
    expect(result?.block, `${cwd} ${path}`).toBe(true);
  }
  expect(
    await guardToolCall(
      makeEvent('write', { path: join(root, 'src/value.ts') }),
      real,
      createStore('locked'),
    ),
  ).toBeUndefined();
});
