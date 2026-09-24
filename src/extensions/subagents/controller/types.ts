import type { SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

import type { OwnedWorker } from '../cancellation.js';
import type { NativeAgentState, Task } from '../types.js';

export interface Handle {
  directory: string;
  task: Task;
  owned?: OwnedWorker;
  paneId?: string;
  terminalId?: string;
  timer?: ReturnType<typeof setTimeout>;
  starting?: Promise<string>;
  stopping?: Promise<void>;
  abort: AbortController;
  expires: number;
  removeLaunchAbort?: () => void;
  workerNeverStarted: boolean;
  workerObserved?: boolean;
  shell?: { processId: number; startedAt: string };
  startError?: string;
  nativeState?: NativeAgentState;
  observationIssue?: string;
  recordErrors: string[];
  shutdownReason?: SessionShutdownEvent['reason'];
  cleanupDetail?: string;
  notifiedQuestions: Set<string>;
}
