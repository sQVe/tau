import { monotonicNow } from './controller/budget.js';
import type { Acknowledgement, Question, Task } from './types.js';

export type WorkerPhase = 'starting' | 'active' | 'waiting' | 'done';

export interface WorkerExtensionState {
  directory: string;
  task: Task | undefined;
  monotonicDeadline: number;
  accepted: boolean;
  reported: boolean;
  incompleteRefused: boolean;
  remindAfterRefusal: boolean;
  settled: boolean;
  runError: string | undefined;
  deadlineWarning: ReturnType<typeof setTimeout> | undefined;
  kickoff: ReturnType<typeof setInterval> | undefined;
  pendingQuestion: Question | undefined;
  parentWatch: ReturnType<typeof setInterval> | undefined;
  questionSettled: boolean;
  replyDelivery: { text: string; acknowledgement: Acknowledgement } | undefined;
  activitySequence: number;
  activityTimer: ReturnType<typeof setTimeout> | undefined;
  phase: WorkerPhase;
  phaseLabel: string | undefined;
  phaseDescription: { text: string; at: number } | undefined;
  usageBaseline:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined;
}

export const hasRunningTask = (
  state: WorkerExtensionState,
): state is WorkerExtensionState & { task: Task } =>
  state.task !== undefined && state.accepted && !state.settled;

export const isTaskActive = (
  state: WorkerExtensionState,
): state is WorkerExtensionState & { task: Task } => hasRunningTask(state) && !state.reported;

export const remainingWork = (state: WorkerExtensionState, task: Task): number =>
  state.monotonicDeadline - task.cancellationBudget - monotonicNow();
