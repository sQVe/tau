import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { customAlphabet } from 'nanoid';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readTask } from './records.js';
import type { Loadout } from './types.js';

export const nameSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 2);

const liveAgentsSchema = Type.Array(
  Type.Object({
    pane_id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  }),
);

// Names only label tasks, so an unreadable record must not block launches. History and follow-up still fail closed.
const retainedNames = (root: string, parentSessionId: string): string[] => {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }
    try {
      const task = readTask(join(root, entry.name));

      return task.parentSessionId === parentSessionId && task.name ? [task.name] : [];
    } catch {
      return [];
    }
  });
};

export const allocateName = (
  root: string,
  parentSessionId: string,
  role: Loadout['role'],
  live: unknown,
  suffix: () => string,
): string => {
  if (!Value.Check(liveAgentsSchema, live)) {
    throw new Error('Malformed live agent listing.');
  }
  const taken = new Set(live.flatMap((agent) => (agent.name ? [agent.name] : [])));
  for (const name of retainedNames(root, parentSessionId)) {
    taken.add(name);
  }

  const prefix = role === 'editing' ? 'worker' : 'investigator';
  for (let attempt = 0; attempt < 32; attempt++) {
    const name = `${prefix}-${suffix()}`;
    if (!taken.has(name)) {
      return name;
    }
  }

  throw new Error('Could not allocate a unique worker name within 32 attempts.');
};
