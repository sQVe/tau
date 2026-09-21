import type { OwnedWorker } from './cancellation.js';
import type { Task } from './types.js';

export interface Handle {
  directory: string;
  task: Task;
  owned?: OwnedWorker;
  paneId?: string;
  terminalId?: string;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
  abort: AbortController;
  expires: number;
  removeLaunchAbort?: () => void;
  workerNeverStarted: boolean;
  workerObserved?: boolean;
  shell?: { processId: number; startedAt: string };
  startError?: string;
  nativeState?: string;
  observationIssue?: string;
  recordErrors: string[];
  cleanupDetail?: string;
  cleanupFinished?: boolean;
  notifiedQuestions: Set<string>;
}
