import type { SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

import type { OwnedWorker } from '../cancellation.js';
import type { Task } from '../types.js';

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
  };
  startup: {
    neverStarted: boolean;
    // Terminals that existed before a Pi launch; a lost launch reply leaves only newer ones to search.
    terminalsBeforeLaunch?: string[];
    // Profile packages the worker loads with -e for this start.
    extensionPackages: string[];
  };
  observation: { notifiedQuestions: Set<string> };
  cleanup: {
    stopping?: Promise<void>;
    recordErrors: string[];
    shutdownReason?: SessionShutdownEvent['reason'];
    detail?: string;
  };
}
