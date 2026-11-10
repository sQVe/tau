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
      description: 'The slice tool draft directory with start.json. Needed unless read has pick.',
    }),
  ),
  pick: Type.Optional(
    Type.String({
      minLength: 1,
      description: 'read: a slice or container identifier.',
    }),
  ),
  agentTeam: Type.String({
    minLength: 1,
    description: 'The team key from the prompt line that starts with `Tracker agent team:`.',
  }),
  stateToken: Type.Optional(Type.String({ description: 'apply: the stateToken from read.' })),
});

type StartInput = Static<typeof startToolParameters>;

const description = `Start a slice and write its agent tickets, as the start-slice skill directs.
- read {pick, agentTeam}: fetches origin and picks the named slice, or a container's first ready child in sub-issue order. Returns {pick: {chosen|null, reason, slices [{identifier, status, blockers [{identifier, state, pullRequests}]}], openBlockerPullRequests, base, defaultBranch}}, plus the draft read with directory. chosen has identifier, title, url, branchName, team, description, pullRequests. status: merged, canceled, completedWithoutMergedPr, blocked, or ready. Blocker state: merged, open, or other. base is origin/<defaultBranch>, or null while a blocker PR is open.
- read {directory, agentTeam}: reads directory/start.json (version 1: {version, slice, branch, base, tickets [{title, file, labels [label IDs], identifier|null}]} in work order), its body files, and the slice's children. Returns {directory, start, writes, problems, stateToken}. writes, in order, each with kind and text: moveToInProgress (unless already In Progress), createTicket (in agentTeam, no project), recordIdentifier (a same-title agent child exists), updateBody (the body file differs from Linear). problems stop apply.
- apply {directory, agentTeam, stateToken}: makes only the checked writes in order, saving each identifier in start.json at once. Before changing a ticket the viewer may not own, it asks the user, and writes nothing without a yes. Returns {status: applied|unchanged|declined, directory, slice, tickets [{number, identifier, url, title, status: new|updated|unchanged}], applied}.
Errors write nothing: a bad start.json or body file, bad linear output, a stale stateToken (read again), or problems. A failed step returns directory, applied, notApplied, and created; read again before a retry.`;

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
