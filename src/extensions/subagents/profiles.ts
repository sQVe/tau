// Adapted from pi-interactive-subagents c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7, index.ts and session.ts. See LICENSE.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Value } from 'typebox/value';

import { isPiLoadout, requireNativeTask, thinkingSchema } from './types.js';
import type { Profile, Task } from './types.js';

const matchField = (line: string) => line.match(/^([a-z-]+):\s*(.+)$/);

const supportedProfileKeys = new Set([
  'name',
  'description',
  'role',
  'model',
  'thinking',
  'cli',
  'session-mode',
  'permissions',
]);

const parseFields = (frontmatter: string) => {
  const fields = new Map<string, string>();

  for (const line of frontmatter.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }

    const match = matchField(line);

    if (!match) {
      throw new Error(`Malformed profile setting: ${line}`);
    }

    const key = match[1];
    const value = match[2];

    if (!key || !value) {
      throw new Error(`Unsupported or duplicate profile setting: ${line}`);
    }

    if (fields.has(key) || !supportedProfileKeys.has(key)) {
      throw new Error(`Unsupported or duplicate profile setting: ${line}`);
    }

    fields.set(key, value.trim());
  }

  return fields;
};

const parseThinking = (thinking = 'medium') => {
  if (!Value.Check(thinkingSchema, thinking)) {
    throw new Error('Invalid profile thinking level.');
  }

  return thinking;
};

const parseRole = (fields: Map<string, string>): Profile['role'] => {
  const role = fields.get('role');

  if (role !== 'investigation' && role !== 'editing') {
    throw new Error('Profile requires an investigation or editing role.');
  }

  return role;
};

const parseHarness = (fields: Map<string, string>): string => {
  const harness = fields.get('cli') ?? 'pi';

  if (!/^[a-z][a-z0-9-]{0,63}$/.test(harness) || harness === 'generic') {
    throw new Error('Invalid herdr kind in profile.');
  }

  return harness;
};

const requireLineageOnly = (fields: Map<string, string>): void => {
  if ((fields.get('session-mode') ?? 'lineage-only') !== 'lineage-only') {
    throw new Error('Workers require fresh lineage-only sessions.');
  }
};

const requireTrustedPermissions = (fields: Map<string, string>): void => {
  if ((fields.get('permissions') ?? 'trusted-full-tools') !== 'trusted-full-tools') {
    throw new Error('Only trusted full-tool workers are supported; roles are not sandboxes.');
  }
};

export const parseProfile = (content: string, fallbackName: string, source: string): Profile => {
  const match = content.replaceAll('\r\n', '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    throw new Error(`Invalid profile: ${source}`);
  }

  const [, frontmatter = '', body = ''] = match;
  const fields = parseFields(frontmatter);
  const role = parseRole(fields);
  const harness = parseHarness(fields);

  requireLineageOnly(fields);
  requireTrustedPermissions(fields);

  if (!body.trim()) {
    throw new Error('Profile instructions are empty.');
  }

  const thinking = parseThinking(fields.get('thinking'));

  return {
    name: fields.get('name') ?? fallbackName,
    role,
    harness,
    harnessSpecified: fields.has('cli'),
    model: fields.get('model'),
    thinking,
    thinkingSpecified: fields.has('thinking'),
    instructions: body.trim(),
    source,
  };
};

export const resolveProfile = (
  cwd: string,
  agentDirectory: string,
  trusted: boolean,
  requestedName: string,
): Profile | undefined => {
  let winner: { content: string; fallbackName: string; source: string } | undefined;
  const directories = [
    fileURLToPath(new URL('./profiles/', import.meta.url)),
    join(agentDirectory, 'agents'),
    ...(trusted ? [join(cwd, '.pi', 'agents')] : []),
  ];

  for (const directory of directories) {
    if (!existsSync(directory)) {
      continue;
    }

    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith('.md'))
      .toSorted()) {
      const source = join(directory, file);
      const content = readFileSync(source, 'utf8');
      const fallbackName = file.slice(0, -3);
      // Read only identity before selection. A malformed winner must still reach strict validation.
      const frontmatter = content
        .replaceAll('\r\n', '\n')
        .match(/^---\n([\s\S]*?)(?:\n---(?:\n|$)|$)/)?.[1];
      const name =
        frontmatter
          ?.split('\n')
          .map(matchField)
          .find((field) => field?.[1] === 'name')?.[2]
          ?.trim() ?? fallbackName;

      if (name === requestedName) {
        winner = { content, fallbackName, source };
      }
    }
  }

  return winner ? parseProfile(winner.content, winner.fallbackName, winner.source) : undefined;
};

export const seedSession = (task: Task): void => {
  const header = {
    type: 'session',
    version: 3,
    id: task.nativeSessionId,
    timestamp: new Date(task.createdAt).toISOString(),
    cwd: task.loadout.cwd,
    parentSession: task.parentSession,
  };

  writeFileSync(requireNativeTask(task).nativeSessionFile, `${JSON.stringify(header)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
};

export const nativeIdentity = (directory: string) => {
  const nativeSessionId = randomUUID();

  return { nativeSessionId, nativeSessionFile: join(directory, `${nativeSessionId}.jsonl`) };
};

export const workerPrompt = (task: Task): string => {
  if (!isPiLoadout(task.loadout)) {
    throw new Error('Only Pi workers use the structured worker prompt.');
  }

  return `${task.loadout.instructions}\n\nTask ${task.taskId} (${task.loadout.role}):\n${task.task}\n\nDeadline: ${new Date(task.deadline).toISOString()}. Work only within this task. Full tools and CC Safety Net are not a sandbox. Do not commit, merge, reset, or run extra model trials. Delegation through subagent stays within this assigned scope and inherits exact settings. Capacity refusal is final for that request: do the work yourself or report the limit; never wait in a retry loop. End your turn to wait for child results; the controller wakes you. Finish or cancel active children before reporting. Preserve unrelated edits. Do not resume arbitrary conversations. Use subagent_follow_up only for an assigned follow-up within this scope. Ask the parent for clarification with subagent_question, never ask_user_question. Waiting does not extend the original deadline or authorize increased scope. Finish by calling subagent_report once with outcome, summary, and evidence. Missing or uncertain handover is not success; do not retry it automatically.`;
};
