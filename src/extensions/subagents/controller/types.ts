import type { SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

import type { OwnedWorker } from '../cancellation.js';
import type { NativeAgentState, Task } from '../types.js';

export interface Handle {
  // The handle's own task and lifetime.
  directory: string;
  task: Task;
  abort: AbortController;
  expires: number;
  timer?: ReturnType<typeof setTimeout>;
  removeLaunchAbort?: () => void;
  // Where the worker runs and the evidence that it is the same worker.
  identity: {
    owned?: OwnedWorker;
    paneId?: string;
    terminalId?: string;
    shell?: { processId: number; startedAt: string };
  };
  startup: { neverStarted: boolean; starting?: Promise<string>; error?: string };
  observation: {
    workerObserved?: boolean;
    nativeState?: NativeAgentState;
    issue?: string;
    notifiedQuestions: Set<string>;
  };
  cleanup: {
    stopping?: Promise<void>;
    recordErrors: string[];
    shutdownReason?: SessionShutdownEvent['reason'];
    detail?: string;
  };
}
