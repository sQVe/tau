import { createHash } from 'node:crypto';

import { decideStartPlan } from './startDecisions.js';
import type { StartPlan } from './startDecisions.js';
import { readStartSlice } from './startLinear.js';
import type { StartSlice } from './startLinear.js';
import { readStartDraft } from './startRecord.js';
import type { StartDraft } from './startRecord.js';
import type { Runtime } from './state.js';

export interface StartState {
  directory: string;
  agentTeam: string;
  draft: StartDraft | undefined;
  slice: StartSlice | undefined;
  plan: StartPlan;
  stateToken: string;
}

// Reads the record, its bodies, and Linear once. The token covers everything the writes depend on.
export const readStartState = async (
  runtime: Runtime,
  directory: string,
  agentTeam: string,
): Promise<StartState> => {
  const draft = await readStartDraft(directory);

  if (draft === undefined) {
    return {
      directory,
      agentTeam,
      draft,
      slice: undefined,
      plan: { writes: [], problems: [`${directory} has no start.json.`] },
      stateToken: '',
    };
  }

  const slice = await readStartSlice(runtime.exec, runtime.root, draft.start.slice);

  if (slice === undefined) {
    throw new Error(`Linear has no issue ${draft.start.slice}.`);
  }

  const plan = decideStartPlan({
    slice: draft.start.slice,
    agentTeam,
    tickets: draft.start.tickets.map((ticket, index) => ({
      title: ticket.title,
      identifier: ticket.identifier,
      body: draft.bodies[index] ?? '',
    })),
    children: slice.children,
  });

  const stateToken = createHash('sha256')
    .update(JSON.stringify({ directory, agentTeam, draft, slice }))
    .digest('hex');

  return { directory, agentTeam, draft, slice, plan, stateToken };
};
