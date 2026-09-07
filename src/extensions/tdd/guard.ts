import { isAbsolute, relative, resolve } from 'node:path';

import type { ToolCallEvent, ToolCallEventResult } from '@mariozechner/pi-coding-agent';

import { classifyPath } from './config.js';
import type { createEvidenceStore } from './state.js';

const inputPaths = (input: unknown, key = ''): string[] => {
  if (typeof input === 'string')
    return /path|file|target|destination|directory|^dir$/i.test(key) ? [input] : [];
  if (Array.isArray(input)) return input.flatMap((value) => inputPaths(value, key));
  if (input !== null && typeof input === 'object') {
    return Object.entries(input).flatMap(([name, value]) => inputPaths(value, name));
  }
  return [];
};

const pathNextStep = (file: string, cwd: string, implementationAllowed: boolean) => {
  const path = relative(cwd, resolve(cwd, file));
  if (file.startsWith('@') || file.startsWith('~'))
    return 'use a literal worktree path without @ or ~';
  if (path === '..' || path.startsWith('../') || isAbsolute(path))
    return 'choose a file inside the worktree';
  if (
    path === '.tau' ||
    path.startsWith('.tau/') ||
    path === 'vite.config.ts' ||
    path === 'package.json'
  )
    return 'choose a test or production file outside the protected paths';
  if (classifyPath(path) === 'test' || implementationAllowed) return undefined;
  return 'run run_tests with scope focused for a failing test that covers this change';
};

export const guardToolCall = async (
  event: ToolCallEvent,
  cwd: string,
  store: Pick<ReturnType<typeof createEvidenceStore>, 'read'>,
): Promise<ToolCallEventResult | undefined> => {
  // Commit's pre-commit formatter runs in a subprocess, outside Pi's file-tool gate.
  if (['read', 'bash', 'grep', 'find', 'ls', 'run_tests', 'commit'].includes(event.toolName))
    return undefined;
  const recognized = event.toolName === 'write' || event.toolName === 'edit';
  const file = recognized ? event.input.path : inputPaths(event.input)[0];
  if (typeof file !== 'string') return undefined;
  const state = await store.read(cwd);
  const next = recognized
    ? pathNextStep(file, cwd, state.implementationAllowed)
    : `use write or edit instead of unrecognized tool ${event.toolName}`;
  if (next === undefined) return undefined;
  return {
    block: true,
    reason: `Blocked ${file} in phase ${state.phase}, active behavior: ${state.evidence.active?.behavior ?? 'none'}. Next: ${next}.`,
  };
};
