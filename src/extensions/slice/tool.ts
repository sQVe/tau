import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../command.js';
import { isMissingFile } from '../../errors.js';
import { ensureTauDirectory, findTauRoot, rejectLinkedEntries } from '../../tauDirectory.js';
import { applySlicePlan } from './apply.js';
import { readPlan } from './draft.js';
import { checkDraftDirectory, draftName } from './draftDirectory.js';
import { readState, slicesPath } from './state.js';
import type { Runtime } from './state.js';
import { describeWrite } from './writes.js';

export const sliceToolParameters = Type.Object({
  action: Type.Union([Type.Literal('prepare'), Type.Literal('read'), Type.Literal('apply')]),
  id: Type.Optional(
    Type.String({
      pattern: '^[a-z0-9][a-z0-9-]*$',
      description: 'prepare: the draft name, such as eng-123 or a slug of the title.',
    }),
  ),
  directory: Type.Optional(
    Type.String({ description: 'read and apply: the draft directory that prepare returned.' }),
  ),
  container: Type.Optional(
    Type.String({
      description: 'read: the container identifier, when the draft has no plan.json yet.',
    }),
  ),
  stateToken: Type.Optional(Type.String({ description: 'apply: the stateToken from read.' })),
});

export type SliceInput = Static<typeof sliceToolParameters>;

const description = `Read and write a slice plan in Linear. Call it as the slice skill directs.
- prepare {id}: creates the ignored draft directory .tau/slices/<id> in the current checkout or bare repository root, or returns the existing one whose plan.json records container <id>. Returns {directory}.
- read {directory, container?}: reads directory/plan.json (version 1: {version, route {team, project|null}, container {identifier|null, title, file}, slices [{identifier|null, title, file, blockedBy [slice numbers]}]}) and its body files, the container, and its children in Linear order with merged (a linked PR is merged), completed, and blockedBy. Returns {directory, draft, container, writes, problems, dropped, orderInPlace, stateToken}. writes lists the Linear writes apply would make, in order, each with kind and text. New slices are created at their plan position, and each open slice out of plan order gets its own moveSlice write. problems lists what stops apply, such as a route mismatch, a completed slice with no merged PR, an unrecorded slice whose title matches a child, or an unrecorded container whose title matches an open issue in the route. dropped lists children the plan leaves out, except canceled ones; they stay in Linear.
- apply {directory, stateToken}: makes the writes in order, records each new identifier in plan.json at once, and moves the draft to .tau/slices/<container identifier> after creating the container. Then it moves an open slice back into plan order when Linear left it out, but only for a slice the viewer owns (assignee is the viewer, or no assignee and the viewer created it); orderInPlace is false when the order is still wrong. A write to a container or slice the viewer does not own (unknown counts as not owned) first asks the user to confirm the writes; it writes nothing if the user declines, there is no UI, or it is a worker. It writes only the contents that read checked. Returns {status: applied|unchanged, directory, container, slices, applied, orderInPlace} or {status: declined, directory, applied: []}.
Errors: a malformed or newer plan.json, a missing body file, a prepare id whose draft records another container, a read container when plan.json records none, bad linear or gh output, a stateToken that no longer matches (read again), or problems. Nothing is written in those cases. A failed or aborted step throws with directory and the applied and notApplied steps. When Linear created a ticket but saving its identifier failed, created holds {identifier, url}: record that identifier in plan.json, then read again before a retry, which also finishes a failed draft move. Merged tickets are never written.`;

// Creates the draft directory and refuses one that a link could send writes outside the checkout.
const createDraftDirectory = async (root: string, name: string) => {
  const directory = await ensureTauDirectory(root, `${slicesPath}/${name}`);

  await rejectLinkedEntries(directory);

  return directory;
};

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const readSavedPlan = (directory: string) =>
  readPlan(directory).then(
    (plan) => ({ directory, plan, error: undefined }),
    (error: unknown) => ({ directory, plan: undefined, error: toError(error) }),
  );

const readDraftEntries = (slices: string) =>
  readdir(slices, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  });

// Picks the draft that records the container, or else the draft named id when it records no other
// container. An unreadable draft stops prepare only when it is the one picked.
const findDraftFor = async (root: string, id: string) => {
  const slices = join(root, '.tau', slicesPath);
  const entries = await readDraftEntries(slices);

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(slices, entry.name));

  const saved = await Promise.all(directories.map((directory) => readSavedPlan(directory)));
  const recorded = saved.find((draft) => draft.plan?.container.identifier?.toLowerCase() === id);
  const selected = recorded ?? saved.find((draft) => basename(draft.directory) === id);

  if (selected === undefined) {
    return id;
  }

  if (selected.error !== undefined) {
    throw selected.error;
  }

  const container = selected.plan?.container.identifier ?? null;

  if (container !== null && container.toLowerCase() !== id) {
    throw new Error(`The draft ${selected.directory} records container ${container}, not ${id}.`);
  }

  return basename(selected.directory);
};

const prepare = async (root: string, id: string | undefined) => {
  if (id === undefined) {
    throw new Error('prepare needs id.');
  }

  return createDraftDirectory(root, await findDraftFor(root, id));
};

const read = async (runtime: Runtime, directory: string, container: string | undefined) => {
  const state = await readState(runtime, directory, container);
  const plan = state.draft?.plan;

  return {
    directory: state.directory,
    draft: state.draft?.plan ?? null,
    container: state.container ?? null,
    writes:
      plan === undefined
        ? []
        : state.writePlan.writes.map((write) => ({
            ...write,
            text: describeWrite(plan, write),
          })),
    problems: state.writePlan.problems,
    dropped: state.writePlan.dropped,
    orderInPlace: state.orderInPlace,
    stateToken: state.stateToken,
  };
};

const runAction = async (
  exec: Exec,
  context: ExtensionContext,
  parameters: SliceInput,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> => {
  const root = await findTauRoot(context.cwd, 'slice');
  const runtime = { exec, root, signal };

  if (parameters.action === 'prepare') {
    return { directory: await prepare(root, parameters.id) };
  }

  const name = draftName(root, parameters.directory);

  if (parameters.action === 'read') {
    const directory = await checkDraftDirectory(root, name, 'read');

    return read(runtime, directory, parameters.container);
  }

  const checkDirectory = () => checkDraftDirectory(root, name, 'apply');
  const directory = await checkDirectory();

  return applySlicePlan(
    runtime,
    context,
    { directory, stateToken: parameters.stateToken },
    checkDirectory,
  );
};

export const createSliceTool = (
  exec: Exec,
): ToolDefinition<typeof sliceToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'slice',
    label: 'Slice',
    description,
    promptSnippet: 'Prepare, read, and apply a slice plan in Linear.',
    parameters: sliceToolParameters,
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
