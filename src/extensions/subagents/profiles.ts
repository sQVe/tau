// Adapted from pi-interactive-subagents c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7, index.ts and session.ts.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Value } from 'typebox/value';

import { assignmentContractFor, handoffContract } from './handoff.js';
import { thinkingSchema, toolNamePattern } from './types.js';
import type { Loadout, Profile, Task } from './types.js';

export interface ProfileSummary {
  name: string;
  description?: string;
}

interface ProfileCandidate {
  name: string;
  description: string | undefined;
  content: string;
  fallbackName: string;
  source: string;
}

const matchField = (line: string) => line.match(/^([a-z-]+):\s*(.+)$/);

const supportedProfileKeys = new Set([
  'name',
  'description',
  'role',
  'model',
  'thinking',
  'cli',
  'tools',
  'skills',
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

    if (key == null || value == null) {
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

export const roleTools: Record<Profile['role'], string[]> = {
  investigation: ['read', 'bash'],
  editing: ['read', 'bash', 'edit', 'write'],
};

export const workerTools = (loadout: Loadout): string[] => [
  ...new Set([...loadout.tools, 'subagent_progress', 'subagent_report', 'subagent_question']),
];

const parseList = (key: string, value: string | undefined): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const items = value.split(',').map((item) => item.trim());

  if (items.some((item) => !item)) {
    throw new Error(`Profile ${key} must be a comma-separated list of names.`);
  }

  return [...new Set(items)];
};

const parseTools = (fields: Map<string, string>, role: Profile['role']): string[] => {
  const tools = parseList('tools', fields.get('tools')) ?? roleTools[role];
  const invalid = tools.find((tool) => !new RegExp(toolNamePattern).test(tool));

  if (invalid !== undefined) {
    throw new Error(`Invalid profile tool name: ${invalid}`);
  }

  return tools;
};

const requirePiCli = (fields: Map<string, string>): void => {
  const cli = fields.get('cli') ?? 'pi';

  if (cli !== 'pi') {
    throw new Error(
      `Profile sets cli: ${cli}, but non-Pi workers are no longer supported. Remove the cli setting to run a Pi worker.`,
    );
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

  requirePiCli(fields);

  if (!body.trim()) {
    throw new Error('Profile instructions are empty.');
  }

  const thinking = parseThinking(fields.get('thinking'));

  return {
    name: fields.get('name') ?? fallbackName,
    role,
    model: fields.get('model'),
    thinking,
    tools: parseTools(fields, role),
    skills: parseList('skills', fields.get('skills')) ?? [],
    instructions: body.trim(),
    source,
  };
};

export const bundledProfileDirectory = fileURLToPath(new URL('./profiles/', import.meta.url));

// Read only identity before selection. A malformed winner must still reach strict validation.
const scanProfiles = (cwd: string, agentDirectory: string, trusted: boolean) => {
  const candidates: ProfileCandidate[] = [];
  const directories = [bundledProfileDirectory, join(agentDirectory, 'agents')];

  if (trusted) {
    directories.push(join(cwd, '.pi', 'agents'));
  }

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

      const fields = content
        .replaceAll('\r\n', '\n')
        .match(/^---\n([\s\S]*?)(?:\n---(?:\n|$)|$)/)?.[1]
        ?.split('\n')
        .map(matchField);

      const field = (key: string) => fields?.find((match) => match?.[1] === key)?.[2]?.trim();

      candidates.push({
        name: field('name') ?? fallbackName,
        description: field('description'),
        content,
        fallbackName,
        source,
      });
    }
  }

  return candidates;
};

export const resolveProfile = (
  cwd: string,
  agentDirectory: string,
  trusted: boolean,
  requestedName: string,
): Profile | undefined => {
  const winner = scanProfiles(cwd, agentDirectory, trusted).findLast(
    (candidate) => candidate.name === requestedName,
  );

  return winner ? parseProfile(winner.content, winner.fallbackName, winner.source) : undefined;
};

// Later directories win, as in resolveProfile. A malformed profile stays listed so launch reports why.
export const listProfiles = (
  cwd: string,
  agentDirectory: string,
  trusted: boolean,
): ProfileSummary[] => {
  const winners = new Map<string, string | undefined>();

  for (const { name, description } of scanProfiles(cwd, agentDirectory, trusted)) {
    winners.set(name, description);
  }

  return [...winners].map(([name, description]) =>
    description === undefined ? { name } : { name, description },
  );
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

  writeFileSync(task.nativeSessionFile, `${JSON.stringify(header)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
};

export const nativeIdentity = (directory: string) => {
  const nativeSessionId = randomUUID();

  return { nativeSessionId, nativeSessionFile: join(directory, `${nativeSessionId}.jsonl`) };
};

// The system prompt holds the standing instructions, so follow-ups and compaction keep them.
export const workerInstructions = (loadout: Loadout): string =>
  [
    loadout.instructions,
    `${assignmentContractFor(loadout.role)}${handoffContract}`,
    [
      'Your tools and CC Safety Net are not a sandbox.',
      'Do not commit, merge, or reset unless the task says so, and never run extra model trials.',
      'Preserve unrelated edits.',
    ].join(' '),
  ].join('\n\n');

export const workerPrompt = (task: Task): string =>
  [
    `Task ${task.taskId}:`,
    task.task,
    '',
    `Deadline: ${new Date(task.deadline).toISOString()}.`,
  ].join('\n');
