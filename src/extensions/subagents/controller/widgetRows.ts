import { join } from 'node:path';

import { readWorkerActivity } from '../activity.js';
import { namePrefix } from '../records.js';
import type { Task } from '../types.js';
import type { WorkerWidgetRow } from '../widget.js';
import { taskRecordStatus } from './record.js';

const readWidgetStatus = (
  directory: string,
  task: Task,
  controlled: boolean,
  entries: { directory: string; task: Task }[],
) => {
  try {
    return taskRecordStatus(directory, task, controlled, entries);
  } catch {
    return undefined;
  }
};

const activityFreshness = 60_000;
const shortTaskIdLength = 6;

const currentActivity = (activity: ReturnType<typeof readWorkerActivity>, now: number): boolean =>
  activity !== undefined &&
  activity.updatedAt <= now &&
  now - activity.updatedAt < activityFreshness;

const phaseActivityText = (
  activity: ReturnType<typeof readWorkerActivity>,
  isCurrent: boolean,
): string | undefined => {
  if (activity?.description === undefined) {
    return undefined;
  }

  if (isCurrent) {
    return activity.description;
  }

  return `${activity.description} (stale)`;
};

const widgetActivity = (
  activity: ReturnType<typeof readWorkerActivity>,
  isCurrent: boolean,
  showPhase: boolean,
): string => {
  const phase = showPhase ? phaseActivityText(activity, isCurrent) : undefined;

  if (phase !== undefined) {
    return phase;
  }

  if (isCurrent && activity?.label != null && activity.label !== '') {
    return activity.label;
  }

  return activity ? 'Pi activity stale' : 'Pi activity unavailable';
};

const widgetModel = (
  task: Task,
  activity: ReturnType<typeof readWorkerActivity>,
  isCurrent: boolean,
): Pick<WorkerWidgetRow, 'requestedModel' | 'observedModel'> => {
  if (isCurrent && activity?.model != null && activity.model !== '') {
    return { requestedModel: task.loadout.model, observedModel: activity.model };
  }

  return { requestedModel: task.loadout.model };
};

const widgetUsage = (activity: ReturnType<typeof readWorkerActivity>): WorkerWidgetRow['usage'] => {
  if (activity?.usage) {
    return {
      available: true,
      label: `Pi active branch: ${activity.usage.input} input · cache read ${activity.usage.cacheRead} · cache write ${activity.usage.cacheWrite} · ${activity.usage.output} output`,
    };
  }

  return {
    available: false,
    reason: 'Pi session usage was not recorded',
  };
};

const widgetQuestion = (
  status: ReturnType<typeof readWidgetStatus>,
): Pick<WorkerWidgetRow, 'question' | 'questionId'> => {
  const question = status?.pendingQuestion;

  if (question?.question == null) {
    return {};
  }

  if ('replySaved' in question && question.replySaved) {
    return {};
  }

  return { question: question.question, questionId: question.questionId };
};

const widgetRecordFields = (
  status: ReturnType<typeof readWidgetStatus>,
): Pick<
  WorkerWidgetRow,
  | 'outcome'
  | 'question'
  | 'questionId'
  | 'terminal'
  | 'cleanup'
  | 'cleanupConfirmed'
  | 'stoppedAt'
  | 'report'
> => {
  const fields: Pick<
    WorkerWidgetRow,
    | 'outcome'
    | 'question'
    | 'questionId'
    | 'terminal'
    | 'cleanup'
    | 'cleanupConfirmed'
    | 'stoppedAt'
    | 'report'
  > = { ...widgetQuestion(status) };

  if (status?.report) {
    fields.outcome = status.report.outcome;
    fields.report = { summary: status.report.summary, evidence: status.report.evidence };
  }

  if (status?.outcome != null) {
    fields.terminal = status.outcome;
  }

  if (status?.cleanup !== undefined) {
    fields.cleanup = status.cleanup;
    fields.cleanupConfirmed = status.cleanupConfirmed;
  }

  if (status?.state === 'stopped' && status.stoppedAt !== undefined) {
    fields.stoppedAt = status.stoppedAt;
  }

  return fields;
};

const widgetManualCleanup = (status: ReturnType<typeof readWidgetStatus>): string => {
  const needsManualCleanup = status?.state === 'cleanupUnconfirmed' || status?.state === 'notOwned';

  if (!needsManualCleanup) {
    return '';
  }

  return `manual cleanup ${status.recovery?.paneId ?? status.recovery?.directory ?? 'inspect status'}`;
};

const widgetEvidencePath = (
  status: ReturnType<typeof readWidgetStatus>,
  directory: string,
): string => {
  if (status?.report) {
    return join(status.directory, 'report.json');
  }

  return join(status?.recovery?.directory ?? directory, 'task.json');
};

const widgetDetailFields = (
  status: ReturnType<typeof readWidgetStatus>,
  directory: string,
): Pick<WorkerWidgetRow, 'details' | 'recovery' | 'workerType' | 'detailPath' | 'issue'> => {
  const fields: Pick<
    WorkerWidgetRow,
    'details' | 'recovery' | 'workerType' | 'detailPath' | 'issue'
  > = {
    details: 'Pi trusted tools + verified safety',
    workerType: 'Pi worker',
    detailPath: widgetEvidencePath(status, directory),
  };

  const recovery = widgetManualCleanup(status);

  if (recovery) {
    fields.recovery = recovery;
  }

  if (!status) {
    fields.issue = 'saved status unavailable; inspect subagent_status';
  }

  return fields;
};

const widgetStatusFields = (
  status: ReturnType<typeof readWidgetStatus>,
  directory: string,
): Pick<
  WorkerWidgetRow,
  | 'outcome'
  | 'question'
  | 'questionId'
  | 'terminal'
  | 'cleanup'
  | 'cleanupConfirmed'
  | 'stoppedAt'
  | 'details'
  | 'recovery'
  | 'workerType'
  | 'detailPath'
  | 'issue'
  | 'report'
> => ({
  ...widgetRecordFields(status),
  ...widgetDetailFields(status, directory),
});

const widgetActivityTime = (
  activity: ReturnType<typeof readWorkerActivity>,
  isCurrent: boolean,
): Pick<WorkerWidgetRow, 'activityAt'> =>
  isCurrent && activity ? { activityAt: activity.updatedAt } : {};

const widgetPhase = (
  activity: ReturnType<typeof readWorkerActivity>,
): Pick<WorkerWidgetRow, 'phaseDescription' | 'phaseDescriptionAt'> => {
  if (activity?.description === undefined) {
    return {};
  }

  if (activity.descriptionAt === undefined) {
    return { phaseDescription: activity.description };
  }

  return {
    phaseDescription: activity.description,
    phaseDescriptionAt: activity.descriptionAt,
  };
};

const buildWidgetRow = (
  directory: string,
  task: Task,
  status: ReturnType<typeof readWidgetStatus>,
  activity: ReturnType<typeof readWorkerActivity>,
): WorkerWidgetRow => {
  const isCurrent = currentActivity(activity, Date.now());
  const state = status?.state ?? 'unknown';
  const showPhase = state === 'starting' || state === 'running';

  return {
    name: task.name ?? `${namePrefix(task.loadout)}-${task.taskId.slice(0, shortTaskIdLength)}`,
    ...(task.label === undefined ? {} : { label: task.label }),
    taskId: task.taskId,
    task: task.task,
    state,
    deadline: task.deadline,
    createdAt: task.createdAt,
    activity: widgetActivity(activity, isCurrent, showPhase),
    ...widgetModel(task, activity, isCurrent),
    usage: widgetUsage(activity),
    ...widgetActivityTime(activity, isCurrent),
    ...widgetPhase(activity),
    ...widgetStatusFields(status, directory),
  };
};

export const widgetRow = (
  directory: string,
  task: Task,
  controlled: boolean,
  entries: { directory: string; task: Task }[],
): WorkerWidgetRow =>
  buildWidgetRow(
    directory,
    task,
    readWidgetStatus(directory, task, controlled, entries),
    readWorkerActivity(directory, task.taskId),
  );
