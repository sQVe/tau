import { relative, resolve } from 'node:path';

import type { ToolCallEvent, ToolCallEventResult } from '@mariozechner/pi-coding-agent';

import { classifyPath } from './config.js';
import type { createEvidenceStore } from './state.js';
import type { Behavior, Phase } from './types.js';

const inputPaths = (input: unknown, key = ''): string[] => {
  if (typeof input === 'string')
    return /path|file|target|destination|directory|^dir$/i.test(key) ? [input] : [];
  if (Array.isArray(input)) return input.flatMap((value) => inputPaths(value, key));
  if (input !== null && typeof input === 'object') {
    return Object.entries(input).flatMap(([name, value]) => inputPaths(value, name));
  }
  return [];
};

const pathNextStep = (
  file: string,
  cwd: string,
  implementationAllowed: boolean,
  active: Behavior | null,
  phase: Phase,
) => {
  const path = relative(cwd, resolve(cwd, file));
  if (file.startsWith('@') || file.startsWith('~'))
    return 'List literal worktree paths with ls {"path":"."}';
  if (path === '..' || path.startsWith('../')) return 'List worktree files with ls {"path":"."}';
  if (
    path === '.tau' ||
    path.startsWith('.tau/') ||
    path === 'vite.config.ts' ||
    path === 'package.json'
  )
    return 'Choose an unprotected test file with ls {"path":"."}';
  if (classifyPath(path) === 'test' || implementationAllowed) return undefined;
  if (phase === 'verified')
    return 'Start the next behavior with write using a *.test.ts path and content that tests the missing behavior';
  if (phase === 'green' && active !== null)
    return `Verify with run_tests ${JSON.stringify({ ...active, scope: 'full' })}`;
  return active === null
    ? `Write a failing test with write using path ${JSON.stringify(`${file.replace(/\.tsx?$/, '')}.test.ts`)} and content that checks the missing behavior`
    : `Prove RED with run_tests ${JSON.stringify({ ...active, scope: 'focused' })}`;
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
  const file = recognized ? event.input.path : (inputPaths(event.input)[0] ?? 'unknown target');
  if (typeof file !== 'string') return undefined;
  const state = await store.read(cwd);
  const next = recognized
    ? pathNextStep(file, cwd, state.implementationAllowed, state.evidence.active, state.phase)
    : `Replace unrecognized tool ${event.toolName} with write using a literal path and the intended content`;
  if (next === undefined) return undefined;
  return {
    block: true,
    reason: `Blocked ${file} in phase ${state.phase}, active behavior: ${state.evidence.active?.behavior ?? 'none'}. ${next}.`,
  };
};
