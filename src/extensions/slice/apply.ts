import { rename } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { ensureTauDirectory } from '../../tauDirectory.js';
import { confirmWithUser } from '../../userConfirmation.js';
import type { Draft, Plan } from './draft.js';
import { planFileName, writePlan } from './draft.js';
import {
  changeBlockedBy,
  createIssue,
  moveIssue,
  readContainer,
  readRouteIds,
  updateIssue,
} from './linear.js';
import type { CreatedIssue } from './linear.js';
import { orderedSlices, readState, slicesPath } from './state.js';
import type { Runtime, SliceState } from './state.js';
import { describeWrite, isInPlanOrder } from './writes.js';
import type { LinearContainer, SliceWrite } from './writes.js';

type StepSummary = (
  | SliceWrite
  | { kind: 'moveDraft' }
  | { kind: 'saveIdentifier'; identifier: string }
) & {
  text: string;
  identifier?: string;
};

interface Step {
  summary: StepSummary;
  run: () => Promise<void>;
}

interface ApplyProgress {
  directory: string;
  draft: Draft;
  plan: Plan;
  containerId: string | undefined;
  teamId: string | undefined;
  projectId: string | null;
  urls: Map<string, string>;
}

interface FailedApply {
  directory: string;
  created: CreatedIssue | undefined;
  applied: StepSummary[];
  notApplied: StepSummary[];
}

// Carries the steps a failed apply made and did not make, so the caller can report both.
class SliceApplyError extends Error {
  readonly directory: string;
  readonly created: CreatedIssue | undefined;
  readonly applied: StepSummary[];
  readonly notApplied: StepSummary[];

  constructor(message: string, failure: FailedApply, options: ErrorOptions) {
    super(message, options);
    this.name = 'SliceApplyError';
    this.directory = failure.directory;
    this.created = failure.created;
    this.applied = failure.applied;
    this.notApplied = failure.notApplied;
  }
}

// Linear created the ticket, but the draft does not record its identifier yet.
class IdentifierSaveError extends Error {
  readonly created: CreatedIssue;

  constructor(created: CreatedIssue, options: ErrorOptions) {
    super(`Linear created ${created.identifier}, but saving its identifier failed.`, options);
    this.name = 'IdentifierSaveError';
    this.created = created;
  }
}

const bulletList = (lines: readonly string[]) =>
  lines.length === 0 ? '- none' : lines.map((line) => `- ${line}`).join('\n');

const planSlice = (plan: Plan, number: number) => {
  const slice = plan.slices[number - 1];

  if (slice === undefined) {
    throw new Error(`The draft has no slice ${number}.`);
  }

  return slice;
};

const requireValue = <Value>(value: Value | null | undefined, label: string): Value => {
  if (value === null || value === undefined) {
    throw new Error(`${label} is not known yet.`);
  }

  return value;
};

const needsMove = (progress: ApplyProgress) => {
  const identifier = progress.plan.container.identifier;

  return identifier !== null && basename(progress.directory) !== identifier.toLowerCase();
};

const moveDraft = async (runtime: Runtime, progress: ApplyProgress) => {
  const identifier = requireValue(progress.plan.container.identifier, 'The container identifier');
  const parent = await ensureTauDirectory(runtime.root, slicesPath);
  const target = join(parent, identifier.toLowerCase());

  await rename(progress.directory, target);
  progress.directory = target;
};

const saveIdentifier = async (progress: ApplyProgress, created: CreatedIssue) => {
  progress.urls.set(created.identifier, created.url);

  try {
    await writePlan(progress.directory, progress.plan);
  } catch (error) {
    throw new IdentifierSaveError(created, { cause: error });
  }
};

const createContainer = async (runtime: Runtime, progress: ApplyProgress) => {
  const { plan } = progress;
  const ids = await readRouteIds(runtime.exec, runtime.root, plan.route);

  const created = await createIssue(runtime.exec, runtime.root, {
    team: ids.team,
    project: ids.project,
    parent: null,
    title: plan.container.title,
    description: progress.draft.containerBody,
    subIssueSortOrder: undefined,
  });

  plan.container.identifier = created.identifier;
  progress.containerId = created.id;
  progress.teamId = ids.team;
  progress.projectId = ids.project;
  await saveIdentifier(progress, created);
};

const createSlice = async (
  runtime: Runtime,
  progress: ApplyProgress,
  write: SliceWrite & { kind: 'createSlice' },
) => {
  const slice = planSlice(progress.plan, write.number);

  const created = await createIssue(runtime.exec, runtime.root, {
    team: requireValue(progress.teamId, 'The container team'),
    project: progress.projectId,
    parent: requireValue(progress.containerId, 'The container ID'),
    title: slice.title,
    description: progress.draft.sliceBodies[write.number - 1] ?? '',
    subIssueSortOrder: write.sortOrder,
  });

  slice.identifier = created.identifier;
  await saveIdentifier(progress, created);
};

const applyWrite = async (runtime: Runtime, progress: ApplyProgress, write: SliceWrite) => {
  const { exec, root } = runtime;
  const { draft, plan } = progress;

  if (write.kind === 'createContainer') {
    return createContainer(runtime, progress);
  }

  if (write.kind === 'createSlice') {
    return createSlice(runtime, progress, write);
  }

  if (write.kind === 'moveSlice') {
    return moveIssue(exec, root, write.identifier, write.sortOrder);
  }

  if (write.kind === 'updateContainer') {
    return updateIssue(exec, root, write.identifier, {
      title: write.title ? plan.container.title : undefined,
      description: write.description ? draft.containerBody : undefined,
    });
  }

  if (write.kind === 'updateSlice') {
    return updateIssue(exec, root, write.identifier, {
      title: write.title ? planSlice(plan, write.number).title : undefined,
      description: write.description ? draft.sliceBodies[write.number - 1] : undefined,
    });
  }

  if (write.kind === 'addBlockedBy') {
    return changeBlockedBy(exec, root, {
      action: 'add',
      identifier: requireValue(planSlice(plan, write.number).identifier, 'The slice'),
      blocker: requireValue(planSlice(plan, write.blocker).identifier, 'The blocker'),
    });
  }

  return changeBlockedBy(exec, root, {
    action: 'delete',
    identifier: write.identifier,
    blocker: write.blocker,
  });
};

const moveStep = (runtime: Runtime, progress: ApplyProgress): Step => ({
  summary: { kind: 'moveDraft', text: 'Move the draft to its container identifier' },
  run: () => moveDraft(runtime, progress),
});

const buildSteps = (runtime: Runtime, progress: ApplyProgress, writes: readonly SliceWrite[]) => {
  const steps: Step[] = [];

  if (needsMove(progress)) {
    steps.push(moveStep(runtime, progress));
  }

  for (const write of writes) {
    steps.push({
      summary: { ...write, text: describeWrite(progress.plan, write) },
      run: () => applyWrite(runtime, progress, write),
    });

    if (write.kind === 'createContainer') {
      steps.push(moveStep(runtime, progress));
    }
  }

  return steps;
};

// A failed save follows a create that Linear made, so the create counts as applied and the save
// does not.
const splitSteps = (summaries: readonly StepSummary[], index: number, error: unknown) => {
  if (!(error instanceof IdentifierSaveError)) {
    return {
      created: undefined,
      applied: summaries.slice(0, index),
      notApplied: summaries.slice(index),
    };
  }

  const { created } = error;
  const failedStep = summaries[index];

  const createStep =
    failedStep === undefined ? [] : [{ ...failedStep, identifier: created.identifier }];

  const saveStep: StepSummary = {
    kind: 'saveIdentifier',
    identifier: created.identifier,
    text: `Record ${created.identifier} (${created.url}) in the draft`,
  };

  return {
    created,
    applied: [...summaries.slice(0, index), ...createStep],
    notApplied: [saveStep, ...summaries.slice(index + 1)],
  };
};

const failedApply = (
  progress: ApplyProgress,
  summaries: readonly StepSummary[],
  index: number,
  error: unknown,
) => {
  const { created, applied, notApplied } = splitSteps(summaries, index, error);
  const texts = (steps: readonly StepSummary[]) => bulletList(steps.map((step) => step.text));

  return new SliceApplyError(
    `A slice step failed: ${errorMessage(error)}\nApplied:\n${texts(applied)}\nNot applied:\n${texts(notApplied)}\nThe draft is in ${progress.directory}. Read it again before a retry.`,
    { directory: progress.directory, created, applied, notApplied },
    { cause: error },
  );
};

const runSteps = async (
  progress: ApplyProgress,
  steps: readonly Step[],
  signal: AbortSignal | undefined,
) => {
  const summaries = steps.map((step) => step.summary);

  for (const [index, step] of steps.entries()) {
    if (signal?.aborted === true) {
      throw failedApply(progress, summaries, index, new Error('The call was aborted.'));
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- Steps run in plan order, and a create records its identifier before the next step.
      await step.run();
    } catch (error) {
      throw failedApply(progress, summaries, index, error);
    }
  }

  return summaries;
};

const rejectChangedState = (state: SliceState, stateToken: string | undefined) => {
  if (state.draft === undefined) {
    throw new Error(`apply needs ${join(state.directory, planFileName)}. Nothing was written.`);
  }

  if (stateToken !== state.stateToken) {
    throw new Error(
      'The draft or Linear changed since the read, or stateToken is missing. Call read again. Nothing was written.',
    );
  }

  if (state.writePlan.problems.length > 0) {
    throw new Error(
      `Apply refuses while read reports problems. Nothing was written:\n${bulletList(state.writePlan.problems)}`,
    );
  }

  return state.draft;
};

const readOrderInPlace = async (runtime: Runtime, progress: ApplyProgress) => {
  const identifier = requireValue(progress.plan.container.identifier, 'The container identifier');
  const container = await readContainer(runtime.exec, runtime.root, identifier);

  if (container === undefined) {
    throw new Error(`Could not read ${identifier} again to check the slice order.`);
  }

  return isInPlanOrder(orderedSlices({ ...progress.draft, plan: progress.plan }, container));
};

// Every step has reached Linear, so a failed order check reports them all as applied.
const checkOrder = async (
  runtime: Runtime,
  progress: ApplyProgress,
  applied: readonly StepSummary[],
) => {
  try {
    return await readOrderInPlace(runtime, progress);
  } catch (error) {
    throw failedApply(progress, applied, applied.length, error);
  }
};

const confirmMessage = (steps: readonly Step[]) =>
  steps.map((step, index) => `${index + 1}. ${step.summary.text}`).join('\n');

const summary = (progress: ApplyProgress, container: LinearContainer | undefined) => {
  const urls = new Map(progress.urls);

  for (const child of container?.children ?? []) {
    urls.set(child.identifier, child.url);
  }

  if (container !== undefined) {
    urls.set(container.identifier, container.url);
  }

  const identifier = progress.plan.container.identifier;

  return {
    directory: progress.directory,
    container: { identifier, url: identifier === null ? null : (urls.get(identifier) ?? null) },
    slices: progress.plan.slices.map((slice, index) => ({
      number: index + 1,
      identifier: slice.identifier,
      url: slice.identifier === null ? null : (urls.get(slice.identifier) ?? null),
    })),
  };
};

const startProgress = (state: SliceState, draft: Draft): ApplyProgress => ({
  directory: state.directory,
  draft,
  plan: structuredClone(draft.plan),
  containerId: state.container?.id,
  teamId: state.container?.team.id,
  projectId: state.container?.project?.id ?? null,
  urls: new Map(),
});

// Writes only the draft contents and Linear state that the read checked. The state is read again
// after the confirm, since the user can take any time to answer.
export const applySlicePlan = async (
  runtime: Runtime,
  context: ExtensionContext,
  directory: string,
  stateToken: string | undefined,
): Promise<Record<string, unknown>> => {
  const state = await readState(runtime, directory, undefined);
  const draft = rejectChangedState(state, stateToken);
  const progress = startProgress(state, draft);
  const steps = buildSteps(runtime, progress, state.writePlan.writes);

  if (steps.length === 0) {
    return {
      status: 'unchanged',
      ...summary(progress, state.container),
      applied: [],
      orderInPlace: state.orderInPlace,
    };
  }

  const confirmed = await confirmWithUser(context, {
    action: 'Writing to Linear',
    title: 'Write the slice plan to Linear?',
    message: confirmMessage(steps),
  });

  if (!confirmed) {
    return {
      status: 'declined',
      ...summary(progress, state.container),
      applied: [],
      orderInPlace: state.orderInPlace,
    };
  }

  rejectChangedState(await readState(runtime, directory, undefined), state.stateToken);

  const applied = await runSteps(progress, steps, runtime.signal);
  const orderInPlace = await checkOrder(runtime, progress, applied);

  return {
    status: 'applied',
    ...summary(progress, state.container),
    applied,
    orderInPlace,
  };
};
