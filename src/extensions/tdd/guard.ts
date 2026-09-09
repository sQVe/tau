import { lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent';

import { ASK_USER_QUESTION_TOOL } from '../askUserQuestion/index.js';
import { WEB_ACCESS_TOOLS } from '../webAccess/index.js';
import { classifyPath, protectedPaths } from './config.js';
import type { createEvidenceStore } from './state.js';
import type { Behavior, Phase } from './types.js';

// Commit's pre-commit formatter runs in a subprocess, outside Pi's file-tool gate.
const passthroughTools = new Set([
  'read',
  'bash',
  'grep',
  'find',
  'ls',
  'run_tests',
  'commit',
  ASK_USER_QUESTION_TOOL,
  ...WEB_ACCESS_TOOLS,
]);

const inputPaths = (input: unknown, key = ''): string[] => {
  if (typeof input === 'string')
    return /path|file|target|destination|directory|^dir$/i.test(key) ? [input] : [];
  if (Array.isArray(input)) return input.flatMap((value) => inputPaths(value, key));
  if (input !== null && typeof input === 'object') {
    return Object.entries(input).flatMap(([name, value]) => inputPaths(value, name));
  }
  return [];
};

// The deepest existing ancestor decides where a path really lives, so a symlinked spelling of
// the worktree cannot slip a production file past the globs.
const realPath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(await realPath(parent), relative(parent, path));
  }
};

const pathNextStep = (
  file: string,
  path: string,
  implementationAllowed: boolean,
  active: Behavior | null,
  phase: Phase,
  gateOff: boolean,
) => {
  if (file.startsWith('@') || file.startsWith('~'))
    return 'List literal worktree paths with ls {"path":"."}';
  if (path === '.tau' || path.startsWith('.tau/') || protectedPaths.includes(path))
    return 'Choose an unprotected test file with ls {"path":"."}';
  // Turning the gate off permits production edits; protected paths above stay blocked.
  if (gateOff) return undefined;
  // A file outside the worktree is never its production code, and classifyPath says so.
  if (classifyPath(path) !== 'production' || implementationAllowed) return undefined;
  const colocatedTest = JSON.stringify(`${file.replace(/\.tsx?$/, '')}.test.ts`);
  if (phase === 'verified')
    return `Start the next behavior with write using path ${colocatedTest} and content that tests the missing behavior`;
  return active === null
    ? `Write a failing test with write using path ${colocatedTest} and content that checks the missing behavior`
    : `Prove RED with run_tests ${JSON.stringify({ ...active, scope: 'focused' })}`;
};

export const guardToolCall = async (
  event: ToolCallEvent,
  cwd: string,
  store: Pick<ReturnType<typeof createEvidenceStore>, 'read'>,
  onState?: (state: Awaited<ReturnType<ReturnType<typeof createEvidenceStore>['read']>>) => void,
): Promise<ToolCallEventResult | undefined> => {
  if (passthroughTools.has(event.toolName)) return undefined;
  const recognized = event.toolName === 'write' || event.toolName === 'edit';
  const file = recognized ? event.input.path : (inputPaths(event.input)[0] ?? 'unknown target');
  if (typeof file !== 'string') return undefined;
  const state = await store.read(cwd);
  // Pi does not catch a throwing tool_call handler, so a failing footer update would decide
  // whether a write is gated.
  try {
    onState?.(state);
  } catch {
    /* empty */
  }
  const paths = [
    relative(resolve(cwd), resolve(cwd, file)),
    relative(await realPath(cwd), await realPath(resolve(cwd, file))),
  ].map((path) => path.replaceAll('\\', '/'));
  const emptyStub =
    event.toolName === 'write' &&
    event.input.content === '' &&
    (await lstat(resolve(cwd, file)).then(
      () => false,
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
    ));
  const next = recognized
    ? paths
        .map((path) =>
          pathNextStep(
            file,
            path,
            state.implementationAllowed || emptyStub,
            state.evidence.active,
            state.phase,
            state.notice !== undefined,
          ),
        )
        .find((step) => step !== undefined)
    : `Replace unrecognized tool ${event.toolName} with write using a literal path and the intended content`;
  if (next === undefined) return undefined;
  return {
    block: true,
    reason: `Blocked ${file} in phase ${state.phase}, active behavior: ${state.evidence.active?.behavior ?? 'none'}. ${next}.`,
  };
};
