// Adapted from pi-interactive-subagents c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7, index.ts and session.ts. See LICENSE.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Value } from 'typebox/value';

import { thinkingSchema } from './types.js';
import type { Profile, Task } from './types.js';

const matchField = (line: string) => line.match(/^([a-z-]+):\s*(.+)$/);

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
    if (
      !key ||
      !value ||
      fields.has(key) ||
      ![
        'name',
        'description',
        'role',
        'model',
        'thinking',
        'cli',
        'session-mode',
        'permissions',
      ].includes(key)
    ) {
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

export const parseProfile = (content: string, fallbackName: string, source: string): Profile => {
  const match = content.replaceAll('\r\n', '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid profile: ${source}`);
  }
  const [, frontmatter = '', body = ''] = match;
  const fields = parseFields(frontmatter);

  const role = fields.get('role');
  if (role !== 'investigation' && role !== 'editing') {
    throw new Error('Profile requires an investigation or editing role.');
  }
  if ((fields.get('cli') ?? 'pi') !== 'pi') {
    throw new Error('Only Pi workers are supported.');
  }
  if ((fields.get('session-mode') ?? 'lineage-only') !== 'lineage-only') {
    throw new Error('Workers require fresh lineage-only sessions.');
  }
  if ((fields.get('permissions') ?? 'trusted-full-tools') !== 'trusted-full-tools') {
    throw new Error('Only trusted full-tool workers are supported; roles are not sandboxes.');
  }
  if (!body.trim()) {
    throw new Error('Profile instructions are empty.');
  }

  const thinking = parseThinking(fields.get('thinking'));

  return {
    name: fields.get('name') ?? fallbackName,
    role,
    model: fields.get('model'),
    thinking,
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

  writeFileSync(task.nativeSessionFile, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 });
};

export const nativeIdentity = (directory: string) => {
  const nativeSessionId = randomUUID();

  return { nativeSessionId, nativeSessionFile: join(directory, `${nativeSessionId}.jsonl`) };
};

export const workerPrompt = (task: Task): string => {
  return `${task.loadout.instructions}\n\nTask ${task.taskId} (${task.loadout.role}):\n${task.task}\n\nDeadline: ${new Date(task.deadline).toISOString()}. Work only within this task. Full tools and CC Safety Net are not a sandbox. Do not commit, merge, reset, delegate, or run extra model trials. Preserve unrelated edits. Do not continue or resume another conversation. Finish by calling subagent_report once with outcome, summary, and evidence. Missing or uncertain handover is not success; do not retry it automatically.`;
};
