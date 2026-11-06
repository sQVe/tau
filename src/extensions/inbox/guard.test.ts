import { existsSync, readFileSync } from 'node:fs';

import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { installHcCommand } from '../../../tests/hcCommandHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { guardTerminalTyping, terminalTypingReason } from './guard.js';

const makeBashEvent = (command: string): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'tool-call-1',
  toolName: 'bash',
  input: { command },
});

const makeReadEvent = (): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'tool-call-1',
  toolName: 'read',
  input: { path: 'missing.txt' },
});

const installHcOutsideTerminal = () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-inbox-guard-');
  const { bin, log } = installHcCommand(directory);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  vi.stubEnv('HC_FAKE_LOG', log);
  vi.stubEnv('HC_SESSION', 'tau-test-inbox-guard');
  vi.stubEnv('HC_TERMINAL_ID', undefined);

  return () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
};

it('refuses a typed send without running hc, even without a terminal', () => {
  const hcLog = installHcOutsideTerminal();

  expect(guardTerminalTyping(makeBashEvent('hc send t1 hello'))).toEqual({
    block: true,
    reason: terminalTypingReason,
  });

  expect(hcLog()).toBe('');
});

it('lets other hc commands and other tools run', () => {
  const hcLog = installHcOutsideTerminal();

  expect(guardTerminalTyping(makeBashEvent('hc get t1'))).toBeUndefined();
  expect(guardTerminalTyping(makeReadEvent())).toBeUndefined();
  expect(hcLog()).toBe('');
});
