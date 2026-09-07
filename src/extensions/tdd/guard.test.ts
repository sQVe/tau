import type { ToolCallEvent } from '@mariozechner/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { guardToolCall } from './guard.js';
import type { createEvidenceStore } from './state.js';
import type { Phase } from './types.js';

const phases: Phase[] = ['locked', 'red', 'green', 'verified'];
const createStore = (phase: Phase) => ({
  read: vi.fn<ReturnType<typeof createEvidenceStore>['read']>(() =>
    Promise.resolve({
      phase,
      implementationAllowed: phase === 'red',
      focusedPassValid: phase === 'green' || phase === 'verified',
      fullPassValid: phase === 'verified',
      evidence: {
        active: {
          behavior: 'required behavior',
          testFullName: 'required',
          files: ['value.test.ts'],
        },
        reds: [],
        red: null,
        focusedPass: null,
        fullPass: null,
        latestRun: null,
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

it.each(phases)('allows test writes, including colocated tests, in %s', async (phase) => {
  for (const path of ['value.test.ts', 'src/value.test.ts', 'src/value.spec.tsx']) {
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
    'package.json',
    'src/../package.json',
  ]) {
    for (const tool of ['write', 'edit']) {
      const result = await guardToolCall(makeEvent(tool, { path }), '/repo', createStore(phase));
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain(path);
      expect(result?.reason).toContain(phase);
      expect(result?.reason).toContain('required behavior');
      expect(result?.reason).toContain(
        'Next: choose a test or production file outside the protected paths',
      );
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
    expect(result?.reason).toContain('Next: use write or edit');
  }
});

it.each(phases)(
  'passes read-only tools, shell commands, and commit hooks through in %s',
  async (phase) => {
    const store = createStore(phase);
    for (const tool of ['read', 'bash', 'grep', 'find', 'ls', 'run_tests', 'commit']) {
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
    expect(result?.reason).toContain('Next: use write or edit');
  }
});

it.each(phases)('refuses paths outside the worktree in %s', async (phase) => {
  for (const path of [
    '../outside.test.ts',
    '/outside.test.ts',
    '/repo-sibling/value.test.ts',
    'src/../../outside.ts',
    '..',
  ]) {
    const result = await guardToolCall(makeEvent('write', { path }), '/repo', createStore(phase));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(path);
    expect(result?.reason).toContain(phase);
    expect(result?.reason).toContain('Next: choose a file inside the worktree');
  }
});

it.each(phases)('uses the stored implementation decision in %s', async (phase) => {
  const store = createStore(phase);
  const result = await guardToolCall(
    makeEvent('write', { path: '/repo/src/value.ts' }),
    '/repo',
    store,
  );
  expect(result?.block === true).toBe(phase !== 'red');
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
    expect(result?.reason).toContain('Next: use a literal worktree path without @ or ~');
  }
});
