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
import type { SliceApplyDetails, StepSummary } from './apply.js';
import { readPlan } from './draft.js';
import type { Plan } from './draft.js';
import { checkDraftDirectory, draftName } from './draftDirectory.js';
import { PartialApplyError, partialApplyToolResult } from './partialApply.js';
import type { PartialApplyFailureDetails } from './partialApply.js';
import { readState, slicesPath } from './state.js';
import type { Runtime } from './state.js';
import { describeWrite } from './writes.js';
import type { LinearContainer, SliceWrite } from './writes.js';

interface SlicePrepareDetails {
  directory: string;
}

export interface SliceReadDetails {
  directory: string;
  draft: Plan | null;
  container: LinearContainer | null;
  writes: (SliceWrite & { text: string })[];
  problems: string[];
  dropped: string[];
  orderInPlace: boolean;
  stateToken: string;
}

type SliceSuccessDetails = SlicePrepareDetails | SliceReadDetails | SliceApplyDetails;

export type SliceToolDetails = SliceSuccessDetails | PartialApplyFailureDetails<StepSummary>;

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

const description = `Read/apply Linear slice plans.
- prepare {id}: new or existing container draft; returns {directory}.
- read {directory,container?}: plan.json v1: {version,route:{team,project|null},container:{identifier|null,title,file},slices:[{identifier|null,title,file,blockedBy:[slice numbers]}]}, plus body files. All keys required; null identifier: new ticket; null project: no project. Returns {directory,draft,container,writes,problems,dropped,orderInPlace,stateToken}. Null draft: no plan.json; null container: no identifier. container children: Linear order, merged (linked PR merged), completed, blockedBy. writes: ordered {kind,text,...} plans; problems: apply blockers; dropped: omitted non-canceled children, kept in Linear.
- apply {directory,stateToken}: only read's checked contents; stale token writes nothing, read again. Returns {status:applied|unchanged,directory,container,slices,applied,orderInPlace} or {status:declined,directory,applied:[]}. Use returned directory after a container create. orderInPlace: false if slice order remains wrong; follow-up moves require viewer ownership (assignee, else creator when unassigned). Non-owned/unknown ownership requires confirmation; decline, no UI, or worker writes nothing. Merged tickets are never written.
Failed/aborted step: {directory,applied,notApplied,created}. Unsaved created ticket: created has {identifier,url}; record it in plan.json, then read again.`;

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

const read = async (
  runtime: Runtime,
  directory: string,
  container: string | undefined,
): Promise<SliceReadDetails> => {
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
): Promise<SliceSuccessDetails> => {
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
): ToolDefinition<typeof sliceToolParameters, SliceToolDetails> =>
  defineTool({
    name: 'slice',
    label: 'Slice',
    description,
    promptSnippet: 'Prepare, read, and apply a slice plan in Linear.',
    parameters: sliceToolParameters,
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
