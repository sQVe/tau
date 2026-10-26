import { customAlphabet } from 'nanoid';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { namePrefix } from './records.js';
import type { Loadout } from './types.js';

export interface NameAllocation {
  // Names of the parent session's saved tasks; names are unique within one parent session.
  retained: string[];
  loadout: Loadout;
  live: unknown;
  suffix: () => string;
}

export const nameSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 2);

const maximumNameAttempts = 32;

const liveAgentsSchema = Type.Array(
  Type.Object({
    pane_id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  }),
);

export const allocateName = (allocation: NameAllocation): string => {
  if (!Value.Check(liveAgentsSchema, allocation.live)) {
    throw new Error('Malformed live agent listing.');
  }

  const taken = new Set(
    allocation.live.flatMap((agent) => (agent.name != null ? [agent.name] : [])),
  );

  for (const name of allocation.retained) {
    taken.add(name);
  }

  const prefix = namePrefix(allocation.loadout);

  for (let attempt = 0; attempt < maximumNameAttempts; attempt++) {
    const name = `${prefix}-${allocation.suffix()}`;

    if (!taken.has(name)) {
      return name;
    }
  }

  throw new Error('Could not allocate a unique worker name within 32 attempts.');
};
