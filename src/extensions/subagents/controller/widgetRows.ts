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
  'outcome' | 'question' | 'questionId' | 'cleanupConfirmed' | 'stoppedAt'
> => {
  const fields: Pick<
    WorkerWidgetRow,
    'outcome' | 'question' | 'questionId' | 'cleanupConfirmed' | 'stoppedAt'
  > = { ...widgetQuestion(status) };

  if (status?.report) {
    fields.outcome = status.report.outcome;
  }

  if (status?.cleanup !== undefined) {
    fields.cleanupConfirmed = status.cleanupConfirmed;
  }

  if (status?.state === 'stopped' && status.stoppedAt !== undefined) {
    fields.stoppedAt = status.stoppedAt;
  }

  return fields;
};

const buildWidgetRow = (
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
    createdAt: task.createdAt,
    activity: widgetActivity(activity, isCurrent, showPhase),
    ...widgetModel(task, activity, isCurrent),
    ...widgetRecordFields(status),
  };
};

export const widgetRow = (
  directory: string,
  task: Task,
  controlled: boolean,
  entries: { directory: string; task: Task }[],
): WorkerWidgetRow =>
  buildWidgetRow(
    task,
    readWidgetStatus(directory, task, controlled, entries),
    readWorkerActivity(directory, task.taskId),
  );
