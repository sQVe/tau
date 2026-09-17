import { customAlphabet } from 'nanoid';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readTasks } from './records.js';
import type { Loadout } from './types.js';

export const nameSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 2);

const liveAgentsSchema = Type.Array(
  Type.Object({
    pane_id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  }),
);

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
  for (const { task } of readTasks(root)) {
    if (task.parentSessionId === parentSessionId && task.name) {
      taken.add(task.name);
    }
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
