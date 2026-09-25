import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { customAlphabet } from 'nanoid';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors/index.js';
import { namePrefix, readTask } from './records.js';
import type { Loadout } from './types.js';

export interface NameAllocation {
  root: string;
  parentSessionId: string;
  loadout: Loadout;
  live: unknown;
  suffix: () => string;
}

export const nameSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 2);

const liveAgentsSchema = Type.Array(
  Type.Object({
    pane_id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  }),
);

// Names only label tasks, so an unreadable record must not block launches.
const retainedNames = (root: string, parentSessionId: string): string[] => {
  let entries;

  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
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

      return task.parentSessionId === parentSessionId && task.name != null ? [task.name] : [];
    } catch {
      return [];
    }
  });
};

export const allocateName = (allocation: NameAllocation): string => {
  if (!Value.Check(liveAgentsSchema, allocation.live)) {
    throw new Error('Malformed live agent listing.');
  }

  const taken = new Set(
    allocation.live.flatMap((agent) => (agent.name != null ? [agent.name] : [])),
  );

  for (const name of retainedNames(allocation.root, allocation.parentSessionId)) {
    taken.add(name);
  }

  const prefix = namePrefix(allocation.loadout);

  for (let attempt = 0; attempt < 32; attempt++) {
    const name = `${prefix}-${allocation.suffix()}`;

    if (!taken.has(name)) {
      return name;
    }
  }

  throw new Error('Could not allocate a unique worker name within 32 attempts.');
};
