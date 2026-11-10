import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../command.js';
import { findTauRoot } from '../../tauDirectory.js';
import { checkDraftDirectory, draftName } from './draftDirectory.js';
import { PartialApplyError, partialApplyToolResult } from './partialApply.js';
import type { PartialApplyFailureDetails } from './partialApply.js';
import { applyStart, describeStartWrite } from './startApply.js';
import type { StartApplyDetails } from './startApply.js';
import type { StartWrite } from './startDecisions.js';
import { readStartPick } from './startPick.js';
import type { StartPick } from './startPickDecisions.js';
import type { Start } from './startRecord.js';
import { readStartState } from './startState.js';
import type { Runtime } from './state.js';

export interface StartReadDetails {
  directory: string;
  start: Start | null;
  writes: (StartWrite & { text: string })[];
  problems: string[];
  stateToken: string;
  pick?: StartPick;
}

type StartSuccessDetails = StartReadDetails | StartApplyDetails | { pick: StartPick };

export type StartToolDetails = StartSuccessDetails | PartialApplyFailureDetails<string>;

export const startToolParameters = Type.Object({
  action: Type.Union([Type.Literal('read'), Type.Literal('apply')]),
  directory: Type.Optional(
    Type.String({
      description:
        'The draft directory that the slice tool prepared, which holds start.json. Required for apply and read without pick.',
    }),
  ),
  pick: Type.Optional(
    Type.String({
      minLength: 1,
      description: 'read: a slice or container identifier to pick a ready slice.',
    }),
  ),
  agentTeam: Type.String({
    minLength: 1,
    description: 'The team key from the prompt line that starts with `Tracker agent team:`.',
  }),
  stateToken: Type.Optional(Type.String({ description: 'apply: the stateToken from read.' })),
});

type StartInput = Static<typeof startToolParameters>;

const description = `Create and update the agent tickets of a slice in Linear. Call it as the start-slice skill directs.
- read {pick, agentTeam}: picks the named slice or first ready child in its team, in sub-issue order. Returns only {pick}: {chosen {identifier, title, url, branchName, team, description, pullRequests}|null, reason, slices [{identifier, status, blockers [{identifier, state, pullRequests}]}], openBlockerPullRequests, base, defaultBranch}. Status is merged, canceled, completedWithoutMergedPr, blocked, or ready. Blocker state is merged, open, or other. PR fields are URLs. base is origin/<defaultBranch> without open blockers, else null for stack chain. With directory too, returns both pick and the draft read.
- read {directory, agentTeam}: reads directory/start.json (version 1: {version, slice, branch, base, tickets [{title, file, labels [label IDs], identifier|null}]} in work order), the body files it names, and the slice's children. Returns {directory, start, writes, problems, stateToken}. writes lists what apply would do, in order, each with kind and text: createTicket (under the slice in agentTeam, no project, with its labels), recordIdentifier (a same-title child of the slice that is in agentTeam with no project), and updateBody (the body file differs from the description in Linear). problems lists what stops apply, such as a same-title child that is not in agentTeam or has a project, or a recorded identifier that is not a child of the slice. Nothing is written.
- apply {directory, agentTeam, stateToken}: makes the writes in order, and records each new or found identifier in start.json at once. Writes only what read checked. When a body update would change a ticket the Linear viewer does not own (not the assignee, or no assignee and not the creator; unknown counts as not owned), it first asks the user to confirm the writes, and writes nothing if the user declines, the session has no UI, or it is a worker. Returns {status: applied|unchanged|declined, directory, slice, tickets [{number, identifier, url, title, status: new|updated|unchanged}], applied}.
Errors: a missing, malformed, or newer start.json, a missing body file, bad linear output, a stateToken that no longer matches (read again), or problems. Nothing is written in those cases. A failed or aborted step returns an error result with directory, applied, notApplied, and created. When a create fails or prints no identifier, read again before any retry: read finds the created child by title.`;

const read = async (
  runtime: Runtime,
  input: StartInput,
  directory: string,
): Promise<StartReadDetails> => {
  const state = await readStartState(runtime, directory, input.agentTeam);
  const start = state.draft?.start;

  return {
    directory,
    start: start ?? null,
    writes:
      start === undefined
        ? []
        : state.plan.writes.map((write) => ({ ...write, text: describeStartWrite(start, write) })),
    problems: state.plan.problems,
    stateToken: state.stateToken,
  };
};

const runAction = async (
  exec: Exec,
  context: ExtensionContext,
  parameters: StartInput,
  signal: AbortSignal | undefined,
): Promise<StartSuccessDetails> => {
  if (parameters.action === 'apply' && parameters.pick !== undefined) {
    throw new Error('pick is only supported for read.');
  }

  if (parameters.action === 'apply' && parameters.directory === undefined) {
    throw new Error('apply requires directory.');
  }

  if (parameters.directory === undefined && parameters.pick === undefined) {
    throw new Error('read requires directory or pick.');
  }

  const root = await findTauRoot(context.cwd, 'start_slice');
  const runtime = { exec, root, signal };

  const pick =
    parameters.pick === undefined ? undefined : await readStartPick(runtime, parameters.pick);

  if (parameters.directory === undefined && pick !== undefined) {
    return { pick };
  }

  const name = draftName(root, parameters.directory);
  const directory = await checkDraftDirectory(root, name, parameters.action);

  if (parameters.action === 'read') {
    const details = await read(runtime, parameters, directory);

    return { ...details, ...(pick === undefined ? {} : { pick }) };
  }

  const request = {
    directory,
    agentTeam: parameters.agentTeam,
    stateToken: parameters.stateToken,
  };

  return applyStart(runtime, context, request, () => checkDraftDirectory(root, name, 'apply'));
};

export const createStartSliceTool = (
  exec: Exec,
): ToolDefinition<typeof startToolParameters, StartToolDetails> =>
  defineTool({
    name: 'start_slice',
    label: 'Start slice',
    description,
    promptSnippet: 'Read and apply the agent tickets of a slice in Linear.',
    parameters: startToolParameters,
    // Two apply calls that ran at once could both pass the stateToken check.
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      try {
        const details = await runAction(exec, context, parameters, signal);

        return {
          content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
          details,
        };
      } catch (error) {
        if (error instanceof PartialApplyError) {
          return partialApplyToolResult(error);
        }

        throw error;
      }
    },
  });
