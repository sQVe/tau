import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { confirmWithUser } from '../../dialog/dialog.js';
import { isWorkerProcess } from '../../worker.js';
import type { Draft } from './draft.js';
import { readDraft } from './draft.js';
import { decideForeignWrites } from './foreignWrites.js';
import type { ExistingTicket } from './foreignWrites.js';
import { readState } from './state.js';
import type { Runtime, SliceState } from './state.js';
import { describeWrite } from './writes.js';
import type { SliceWrite } from './writes.js';

type TicketUpdate = Extract<SliceWrite, { kind: 'updateContainer' | 'updateSlice' }>;

// The draft or its directory can change while readState awaits Linear.
export const rejectChangedDraft = async (
  state: SliceState,
  checkDirectory: () => Promise<unknown>,
): Promise<void> => {
  await checkDirectory();
  const current = await readDraft(state.directory);

  if (!isDeepStrictEqual(current, state.draft)) {
    throw new Error('The draft changed since the read. Call read again. Nothing was written.');
  }
};

// A worker or a session without UI cannot answer, so apply declines without writing.
const canAskUser = (context: ExtensionContext) => context.hasUI && !isWorkerProcess();

const existingTickets = (state: SliceState): ExistingTicket[] =>
  state.container === undefined ? [] : [state.container, ...state.container.children];

const isTicketUpdate = (write: SliceWrite): write is TicketUpdate =>
  write.kind === 'updateContainer' || write.kind === 'updateSlice';

const isDescriptionReplacement = (write: SliceWrite): write is TicketUpdate =>
  isTicketUpdate(write) && write.description;

const currentDescription = (state: SliceState, identifier: string) => {
  if (state.container?.identifier === identifier) {
    return state.container.description;
  }

  return state.container?.children.find((child) => child.identifier === identifier)?.description;
};

const replacementBody = (draft: Draft, write: TicketUpdate) =>
  write.kind === 'updateContainer'
    ? draft.containerBody
    : (draft.sliceBodies[write.number - 1] ?? '');

const foreignBodies = (foreign: readonly string[], draft: Draft, state: SliceState) =>
  state.writePlan.writes.flatMap((write) => {
    if (!isDescriptionReplacement(write) || !foreign.includes(write.identifier)) {
      return [];
    }

    const current = currentDescription(state, write.identifier) ?? '';
    const body = replacementBody(draft, write);

    return [
      `${write.identifier} now holds:\n---\n${current}\n---\n${write.identifier} will hold:\n---\n${body}\n---`,
    ];
  });

const confirmMessage = (foreign: readonly string[], draft: Draft, state: SliceState) => {
  const texts = state.writePlan.writes.map((write) => `- ${describeWrite(draft.plan, write)}`);
  const owner = `Another person owns these tickets, or the owner is unknown: ${foreign.join(', ')}.`;
  const bodies = foreignBodies(foreign, draft, state);
  const bodySection = bodies.length === 0 ? '' : `\n\nBody changes:\n${bodies.join('\n\n')}`;

  return `${owner}\n\nWrites:\n${texts.join('\n')}${bodySection}`;
};

// Asks the user once before a planned write changes an existing ticket the viewer does not own.
// The state can change while the user answers, so a changed state stops the apply before any write.
export const approveForeignWrites = async (
  runtime: Runtime,
  context: ExtensionContext,
  request: { state: SliceState; draft: Draft },
  checkDirectory: () => Promise<unknown>,
): Promise<'proceed' | 'declined'> => {
  const { state, draft } = request;
  const sliceIdentifiers = draft.plan.slices.map((slice) => slice.identifier);

  const foreign = decideForeignWrites(
    state.container?.viewer ?? '',
    state.writePlan.writes,
    sliceIdentifiers,
    existingTickets(state),
  );

  if (foreign.length === 0) {
    return 'proceed';
  }

  if (!canAskUser(context)) {
    return 'declined';
  }

  const confirmed = await confirmWithUser(context, {
    action: 'Updating a ticket another person owns',
    title: `Update ${foreign.join(', ')} in Linear`,
    message: confirmMessage(foreign, draft, state),
  });

  if (!confirmed) {
    return 'declined';
  }

  const current = await readState(runtime, state.directory, undefined);

  if (current.stateToken !== state.stateToken) {
    throw new Error(
      'The draft or Linear changed while you answered. Call read again. Nothing was written.',
    );
  }

  await rejectChangedDraft(state, checkDirectory);

  return 'proceed';
};
