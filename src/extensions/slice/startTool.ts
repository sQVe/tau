import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../exec.js';
import { findTauRoot } from '../../tauDirectory.js';
import { checkDraftDirectory, draftName } from './draftDirectory.js';
import { applyStart, describeStartWrite } from './startApply.js';
import { readStartState } from './startState.js';
import type { Runtime } from './state.js';

export const startToolParameters = Type.Object({
  action: Type.Union([Type.Literal('read'), Type.Literal('apply')]),
  directory: Type.String({
    description: 'The draft directory that the slice tool prepared, which holds start.json.',
  }),
  agentTeam: Type.String({
    minLength: 1,
    description: 'The team key from the prompt line that starts with `Tracker agent team:`.',
  }),
  stateToken: Type.Optional(Type.String({ description: 'apply: the stateToken from read.' })),
});

type StartInput = Static<typeof startToolParameters>;

const description = `Create and update the agent tickets of a slice in Linear. Call it as the start-slice skill directs.
- read {directory, agentTeam}: reads directory/start.json (version 1: {version, slice, branch, base, tickets [{title, file, labels [label IDs], identifier|null}]} in work order), the body files it names, and the slice's children. Returns {directory, start, writes, problems, stateToken}. writes lists what apply would do, in order, each with kind and text: createTicket (under the slice in agentTeam, no project, with its labels), recordIdentifier (a same-title child of the slice that is in agentTeam with no project), and updateBody (the body file differs from the description in Linear). problems lists what stops apply, such as a same-title child that is not in agentTeam or has a project, or a recorded identifier that is not a child of the slice. Nothing is written.
- apply {directory, agentTeam, stateToken}: makes the writes in order, and records each new or found identifier in start.json at once. Writes only what read checked. When a body update would change a ticket the Linear viewer does not own (not the assignee, or no assignee and not the creator; unknown counts as not owned), it first asks the user to confirm the writes, and writes nothing if the user declines, the session has no UI, or it is a worker. Returns {status: applied|unchanged|declined, directory, slice, tickets [{number, identifier, url, title, status: new|updated|unchanged}], applied}.
Errors: a missing, malformed, or newer start.json, a missing body file, bad linear output, a stateToken that no longer matches (read again), or problems. Nothing is written in those cases. A failed or aborted step throws with the steps applied and not applied. When a create fails or prints no identifier, read again before any retry: read finds the created child by title.`;

const read = async (runtime: Runtime, input: StartInput, directory: string) => {
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
): Promise<Record<string, unknown>> => {
  const root = await findTauRoot(context.cwd, 'start_slice');
  const runtime = { exec, root, signal };
  const name = draftName(root, parameters.directory);
  const directory = await checkDraftDirectory(root, name, parameters.action);

  if (parameters.action === 'read') {
    return read(runtime, parameters, directory);
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
): ToolDefinition<typeof startToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'start_slice',
    label: 'Start slice',
    description,
    promptSnippet: 'Read and apply the agent tickets of a slice in Linear.',
    parameters: startToolParameters,
    // Two apply calls that ran at once could both pass the stateToken check.
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const details = await runAction(exec, context, parameters, signal);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
