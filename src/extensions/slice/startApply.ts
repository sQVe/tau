import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { confirmWithUser } from '../../confirm.js';
import { errorMessage } from '../../errors.js';
import { createIssue, readRouteIds, updateIssue } from './linear.js';
import { decideForeignUpdates } from './startDecisions.js';
import type { StartWrite } from './startDecisions.js';
import { readStartDraft, writeStart } from './startRecord.js';
import type { Start, StartDraft } from './startRecord.js';
import { readStartState } from './startState.js';
import type { StartState } from './startState.js';
import type { Runtime } from './state.js';

interface StartProgress {
  directory: string;
  agentTeam: string;
  sliceId: string;
  draft: StartDraft;
  start: Start;
  urls: Map<string, string>;
  changed: Set<number>;
  created: Set<number>;
}

export const describeStartWrite = (start: Start, write: StartWrite): string => {
  const ticket = start.tickets[write.number - 1];
  const label = `ticket ${write.number} "${ticket?.title ?? ''}"`;

  if (write.kind === 'createTicket') {
    return `Create ${label} under ${start.slice} in the agent team`;
  }

  if (write.kind === 'recordIdentifier') {
    return `Record ${write.identifier} for ${label} in start.json`;
  }

  return `Update the body of ${write.identifier} for ${label} from its body file`;
};

const bulletList = (lines: readonly string[]) => lines.map((line) => `- ${line}`).join('\n');

const bulletOrNone = (lines: readonly string[]) =>
  lines.length === 0 ? '- none' : bulletList(lines);

const requireTicket = (progress: StartProgress, number: number) => {
  const ticket = progress.start.tickets[number - 1];

  if (ticket === undefined) {
    throw new Error(`The start record has no ticket ${number}.`);
  }

  return ticket;
};

const createMessage = (number: number, title: string, reason: string) =>
  `Creating ticket ${number} "${title}" failed or printed no identifier: ${reason}. Linear may have created it. Call read again before any retry: read finds a created child by its title, so a retry does not create it twice.`;

const createTicket = async (runtime: Runtime, progress: StartProgress, number: number) => {
  const ticket = requireTicket(progress, number);
  const body = progress.draft.bodies[number - 1] ?? '';

  const route = { team: progress.agentTeam, project: null };
  const ids = await readRouteIds(runtime.exec, runtime.root, route);

  const created = await createIssue(runtime.exec, runtime.root, {
    team: ids.team,
    project: null,
    parent: progress.sliceId,
    title: ticket.title,
    description: body,
    subIssueSortOrder: undefined,
    labels: ticket.labels,
  }).catch((error: unknown) => {
    throw new Error(createMessage(number, ticket.title, errorMessage(error)), { cause: error });
  });

  progress.urls.set(created.identifier, created.url);
  progress.created.add(number);
  ticket.identifier = created.identifier;

  await writeStart(progress.directory, progress.start).catch((error: unknown) => {
    throw new Error(
      `Linear created ${created.identifier} (${created.url}) for ticket ${number}, but saving its identifier failed: ${errorMessage(error)}. Call read again: it finds the child by title and records it.`,
      { cause: error },
    );
  });
};

const recordIdentifier = async (
  progress: StartProgress,
  write: StartWrite & { kind: 'recordIdentifier' },
) => {
  requireTicket(progress, write.number).identifier = write.identifier;
  await writeStart(progress.directory, progress.start);
};

const applyWrite = async (runtime: Runtime, progress: StartProgress, write: StartWrite) => {
  if (write.kind === 'createTicket') {
    return createTicket(runtime, progress, write.number);
  }

  if (write.kind === 'recordIdentifier') {
    return recordIdentifier(progress, write);
  }

  progress.changed.add(write.number);

  return updateIssue(runtime.exec, runtime.root, write.identifier, {
    title: undefined,
    description: progress.draft.bodies[write.number - 1],
  });
};

const failedApply = (descriptions: readonly string[], index: number, error: unknown) =>
  new Error(
    `Start stopped at step ${index + 1}: ${errorMessage(error)}\nApplied:\n${bulletOrNone(descriptions.slice(0, index))}\nNot applied:\n${bulletList(descriptions.slice(index))}`,
    { cause: error },
  );

const runWrites = async (
  runtime: Runtime,
  progress: StartProgress,
  writes: readonly StartWrite[],
) => {
  const descriptions = writes.map((write) => describeStartWrite(progress.start, write));

  for (const [index, write] of writes.entries()) {
    if (runtime.signal?.aborted === true) {
      throw failedApply(descriptions, index, new Error('The call was aborted.'));
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- Writes run in work order.
      await applyWrite(runtime, progress, write);
    } catch (error) {
      throw failedApply(descriptions, index, error);
    }
  }

  return descriptions;
};

const rejectChangedState = (state: StartState, stateToken: string | undefined) => {
  const { draft, slice } = state;

  if (draft === undefined || slice === undefined) {
    throw new Error(`${state.directory} has no start.json. Nothing was written.`);
  }

  if (stateToken === undefined) {
    throw new Error('apply needs the stateToken from read. Nothing was written.');
  }

  if (stateToken !== state.stateToken) {
    throw new Error(
      'The start record or Linear changed since the read. Call read again. Nothing was written.',
    );
  }

  if (state.plan.problems.length > 0) {
    throw new Error(
      `Apply refuses while read reports problems. Nothing was written:\n${bulletList(state.plan.problems)}`,
    );
  }

  return { draft, slice };
};

// The record can change while readStartState awaits Linear.
const rejectChangedRecord = async (state: StartState) => {
  const current = await readStartDraft(state.directory);

  if (!isDeepStrictEqual(current, state.draft)) {
    throw new Error(
      'The start record changed since the read. Call read again. Nothing was written.',
    );
  }
};

const ticketStatus = (progress: StartProgress, number: number) => {
  if (progress.created.has(number)) {
    return 'new';
  }

  return progress.changed.has(number) ? 'updated' : 'unchanged';
};

const summary = (progress: StartProgress, state: StartState) => {
  const urls = new Map(progress.urls);

  for (const child of state.slice?.children ?? []) {
    urls.set(child.identifier, child.url);
  }

  return {
    directory: progress.directory,
    slice: progress.start.slice,
    tickets: progress.start.tickets.map((ticket, index) => ({
      number: index + 1,
      identifier: ticket.identifier,
      url: ticket.identifier === null ? null : (urls.get(ticket.identifier) ?? null),
      title: ticket.title,
      status: ticketStatus(progress, index + 1),
    })),
  };
};

const foreignBodies = (state: StartState, foreign: readonly string[]) => {
  const children = state.slice?.children ?? [];

  return state.plan.writes.flatMap((write) => {
    if (write.kind !== 'updateBody' || !foreign.includes(write.identifier)) {
      return [];
    }

    const current = children.find((child) => child.identifier === write.identifier);
    const body = state.draft?.bodies[write.number - 1] ?? '';

    return [
      `${write.identifier} now holds:\n---\n${current?.description ?? ''}\n---\n${write.identifier} will hold:\n---\n${body}\n---`,
    ];
  });
};

const confirmMessage = (state: StartState, foreign: readonly string[], start: Start) => {
  const writes = state.plan.writes.map((write) => describeStartWrite(start, write));
  const owner = `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not yours, or the owner is unknown.`;

  return `${owner}\n\nWrites:\n${bulletList(writes)}\n\nBody changes:\n${foreignBodies(state, foreign).join('\n\n')}`;
};

// Asks the user before a body update to a ticket another person owns. The state can change while
// the user answers, so a changed state stops the apply before any write.
const confirmForeignUpdates = async (
  runtime: Runtime,
  context: ExtensionContext,
  state: StartState,
  agentTeam: string,
  checkDirectory: () => Promise<unknown>,
) => {
  const { draft, slice } = state;

  const foreign = decideForeignUpdates(
    slice?.viewer ?? '',
    state.plan.writes,
    slice?.children ?? [],
  );

  if (draft === undefined || foreign.length === 0) {
    return 'proceed';
  }

  const confirmed = await confirmWithUser(context, {
    action: 'Updating a ticket another person owns',
    title: `Update ${foreign.join(', ')} in Linear`,
    message: confirmMessage(state, foreign, draft.start),
  });

  if (!confirmed) {
    return 'declined';
  }

  await checkDirectory();

  const current = await readStartState(runtime, state.directory, agentTeam);

  if (current.stateToken !== state.stateToken) {
    throw new Error(
      'The start record or Linear changed while you answered. Call read again. Nothing was written.',
    );
  }

  // A file can change while the second Linear read runs, after the token read it.
  await rejectChangedRecord(state);

  return 'proceed';
};

// Writes only the record contents and Linear state that the read checked.
export const applyStart = async (
  runtime: Runtime,
  context: ExtensionContext,
  request: { directory: string; agentTeam: string; stateToken: string | undefined },
  checkDirectory: () => Promise<unknown>,
): Promise<Record<string, unknown>> => {
  const { directory, agentTeam, stateToken } = request;
  const state = await readStartState(runtime, directory, agentTeam);
  const { draft, slice } = rejectChangedState(state, stateToken);

  await rejectChangedRecord(state);

  const answer = await confirmForeignUpdates(runtime, context, state, agentTeam, checkDirectory);

  if (answer === 'declined') {
    return { status: 'declined', directory, slice: draft.start.slice, applied: [] };
  }

  const progress: StartProgress = {
    directory,
    agentTeam,
    sliceId: slice.id,
    draft,
    start: structuredClone(draft.start),
    urls: new Map(),
    changed: new Set(),
    created: new Set(),
  };

  const applied = await runWrites(runtime, progress, state.plan.writes);

  return {
    status: applied.length === 0 ? 'unchanged' : 'applied',
    ...summary(progress, state),
    applied,
  };
};
