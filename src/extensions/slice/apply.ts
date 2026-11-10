import { rename } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createIssue, moveIssue, readRouteIds, updateIssue } from '../../linear/linear.js';
import type { CreatedIssue } from '../../linear/linear.js';
import { isViewersTicket } from '../../linear/ownership.js';
import { ensureTauDirectory } from '../../tauDirectory.js';
import { approveForeignWrites, rejectChangedDraft } from './applyApproval.js';
import type { Draft, Plan } from './draft.js';
import { planFileName, writePlan } from './draft.js';
import { changeBlockedBy, readContainer } from './linear.js';
import { CreatedButNotRecordedError, failPartialApply, runApplySteps } from './partialApply.js';
import type { ApplyRunner, PartialApplyStep } from './partialApply.js';
import { readState, slicesPath } from './state.js';
import type { Runtime, SliceState } from './state.js';
import { describeWrite, isInPlanOrder, plannedSortOrders } from './writes.js';
import type { LinearChild, LinearContainer, OrderedSlice, SliceWrite } from './writes.js';

export type StepSummary = (
  | SliceWrite
  | { kind: 'moveDraft' }
  | { kind: 'saveIdentifier'; identifier: string }
) & {
  text: string;
  identifier?: string;
};

interface SliceSummary {
  directory: string;
  container: { identifier: string | null; url: string | null };
  slices: { number: number; identifier: string | null; url: string | null }[];
}

export type SliceApplyDetails =
  | { status: 'declined'; directory: string; applied: readonly StepSummary[] }
  | (SliceSummary & {
      status: 'unchanged';
      applied: readonly StepSummary[];
      orderInPlace: boolean;
    })
  | (SliceSummary & {
      status: 'applied';
      applied: readonly StepSummary[];
      orderInPlace: boolean;
    });

interface ApplyProgress {
  directory: string;
  draft: Draft;
  plan: Plan;
  containerId: string | undefined;
  teamId: string | undefined;
  projectId: string | null;
  urls: Map<string, string>;
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
    throw new CreatedButNotRecordedError(created, { cause: error });
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
    labels: [],
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
    labels: [],
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

const moveStep = (runtime: Runtime, progress: ApplyProgress): PartialApplyStep<StepSummary> => ({
  summary: { kind: 'moveDraft', text: 'Move the draft to its container identifier' },
  run: () => moveDraft(runtime, progress),
});

const buildSteps = (runtime: Runtime, progress: ApplyProgress, writes: readonly SliceWrite[]) => {
  const steps: PartialApplyStep<StepSummary>[] = [];

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

const applyRunner = (runtime: Runtime, progress: ApplyProgress): ApplyRunner<StepSummary> => ({
  describe: (summary) => summary.text,
  directory: () => progress.directory,
  recordIdentifier: (created) => ({
    kind: 'saveIdentifier',
    identifier: created.identifier,
    text: `Record ${created.identifier} (${created.url}) in the draft`,
  }),
  signal: runtime.signal,
});

const runSteps = (
  runtime: Runtime,
  progress: ApplyProgress,
  steps: readonly PartialApplyStep<StepSummary>[],
) => runApplySteps(applyRunner(runtime, progress), [], steps);

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

const readSlots = async (runtime: Runtime, progress: ApplyProgress) => {
  const identifier = requireValue(progress.plan.container.identifier, 'The container identifier');
  const container = await readContainer(runtime.exec, runtime.root, identifier);

  if (container === undefined) {
    throw new Error(`Could not read ${identifier} again to check the slice order.`);
  }

  const children = new Map(container.children.map((child) => [child.identifier, child]));

  const slots = progress.plan.slices.map((slice) =>
    slice.identifier === null ? undefined : children.get(slice.identifier),
  );

  return { viewer: container.viewer, slots };
};

const isSlotsInPlanOrder = (slots: readonly (OrderedSlice | undefined)[]) =>
  isInPlanOrder(slots.filter((slot) => slot !== undefined));

const repairSteps = (
  runtime: Runtime,
  progress: ApplyProgress,
  viewer: string,
  slots: readonly (LinearChild | undefined)[],
) => {
  const steps: PartialApplyStep<StepSummary>[] = [];

  for (const [index, sortOrder] of plannedSortOrders(slots).entries()) {
    const slot = slots[index];

    if (slot === undefined || sortOrder === undefined || !isViewersTicket(viewer, slot)) {
      continue;
    }

    const write: SliceWrite = { kind: 'moveSlice', identifier: slot.identifier, sortOrder };

    steps.push({
      summary: { ...write, text: describeWrite(progress.plan, write) },
      run: () => applyWrite(runtime, progress, write),
    });
  }

  return steps;
};

// Every earlier step has reached Linear, so a failed read reports them all as applied.
const readSlotsAfter = async (
  runtime: Runtime,
  progress: ApplyProgress,
  applied: readonly StepSummary[],
) => {
  try {
    return await readSlots(runtime, progress);
  } catch (error) {
    return failPartialApply(applyRunner(runtime, progress), applied, error);
  }
};

const checkOrder = async (
  runtime: Runtime,
  progress: ApplyProgress,
  applied: readonly StepSummary[],
) => {
  const { viewer, slots } = await readSlotsAfter(runtime, progress, applied);

  if (isSlotsInPlanOrder(slots)) {
    return { applied, orderInPlace: true };
  }

  const repairs = repairSteps(runtime, progress, viewer, slots);
  const all = await runApplySteps(applyRunner(runtime, progress), applied, repairs);
  const repaired = await readSlotsAfter(runtime, progress, all);

  return { applied: all, orderInPlace: isSlotsInPlanOrder(repaired.slots) };
};

const summary = (progress: ApplyProgress, container: LinearContainer | undefined): SliceSummary => {
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

// Writes only the draft contents and Linear state that the read checked.
export const applySlicePlan = async (
  runtime: Runtime,
  context: ExtensionContext,
  request: { directory: string; stateToken: string | undefined },
  checkDirectory: () => Promise<unknown>,
): Promise<SliceApplyDetails> => {
  const { directory, stateToken } = request;
  const state = await readState(runtime, directory, undefined);
  const draft = rejectChangedState(state, stateToken);

  await rejectChangedDraft(state, checkDirectory);

  const approval = await approveForeignWrites(runtime, context, { state, draft }, checkDirectory);

  if (approval === 'declined') {
    return { status: 'declined', directory, applied: [] };
  }

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

  const applied = await runSteps(runtime, progress, steps);
  const checked = await checkOrder(runtime, progress, applied);

  return {
    status: 'applied',
    ...summary(progress, state.container),
    applied: checked.applied,
    orderInPlace: checked.orderInPlace,
  };
};
