// An Error makes the call fail the way a failing herdr command does.
export type Reply = string | Error;

export type Surface = 'agent' | 'processInfo';

export interface FakeWorker {
  paneId: string;
  terminalId: string;
  processId: number;
  session: string;
  exited: boolean;
}

interface Registration {
  paneId: string;
  terminalId: string;
  processId?: number;
  session: string;
  command: string[];
}

interface ProcessEvidence {
  processId: number;
  argv: string[];
}

interface HerdrWorkerFake {
  register: (registration: Registration) => void;
  find: (terminalId: string | undefined) => FakeWorker | undefined;
  require: (terminalId: string) => FakeWorker;
  has: (terminalId: string) => boolean;
  isExited: (terminalId: string) => boolean;
  snapshot: () => FakeWorker[];
  exit: (terminalId: string) => void;
  ready: (terminalId: string) => void;
  move: (terminalId: string) => string;
  replaceSession: (terminalId: string, session: string) => void;
  replaceProcess: (terminalId: string) => void;
  processAbsent: (processId: number) => boolean;
  knowsProcess: (processId: number) => boolean;
  processReply: (terminalId: string | undefined) => Reply | undefined;
  processEvidence: (terminalId: string | undefined) => ProcessEvidence | undefined;
  agentReply: (terminalId: string | undefined) => Reply | undefined;
  queueAgentReplies: (terminalId: string, replies: Reply[]) => void;
  malformedEvidence: (terminalId: string, surface: Surface, reply: Reply) => void;
  holdReply: (terminalId: string, surface: Surface, reply: Reply) => void;
}

export const shellProcessId = 100;
const firstWorkerProcessId = 5001;

/**
 * The state of every fake worker, keyed by terminal. A worker runs as its terminal's own process
 * and keeps its identity when herdr moves its pane. Process history outlives the current identity
 * of a worker, so a replaced process stays known.
 */
export const herdrWorkerFake = (): HerdrWorkerFake => {
  const workers = new Map<string, FakeWorker & { command: string[] }>();
  const processes = new Map<number, boolean>([[shellProcessId, false]]);
  let nextProcessId = firstWorkerProcessId;
  // Replies that stand in for the state-derived evidence of one terminal.
  const queuedAgentReplies = new Map<string, Reply[]>();
  const malformedReplies = new Map<string, Reply[]>();
  const heldReplies = new Map<string, Reply>();

  const requireWorker = (terminalId: string) => {
    const worker = workers.get(terminalId);

    if (worker === undefined) {
      throw new Error(`No fake worker has terminal ${terminalId}.`);
    }

    return worker;
  };

  const startProcess = () => {
    const processId = nextProcessId;
    nextProcessId += 1;
    processes.set(processId, false);

    return processId;
  };

  const claimProcess = (processId: number) => {
    processes.set(processId, false);

    return processId;
  };

  const pinnedReply = (surface: Surface, terminalId: string | undefined) => {
    const key = `${surface}:${terminalId}`;

    return malformedReplies.get(key)?.shift() ?? heldReplies.get(key);
  };

  const exit = (terminalId: string) => {
    const worker = requireWorker(terminalId);
    worker.exited = true;
    processes.set(worker.processId, true);
  };

  return {
    register: ({ paneId, terminalId, processId, session, command }) => {
      const workerProcessId = processId === undefined ? startProcess() : claimProcess(processId);

      workers.set(terminalId, {
        paneId,
        terminalId,
        processId: workerProcessId,
        session,
        exited: false,
        command,
      });
    },
    find: (terminalId) => workers.get(terminalId ?? ''),
    require: requireWorker,
    has: (terminalId) => workers.has(terminalId),
    isExited: (terminalId) => workers.get(terminalId)?.exited === true,
    snapshot: () =>
      [...workers.values()].map(({ paneId, terminalId, processId, session, exited }) => ({
        paneId,
        terminalId,
        processId,
        session,
        exited,
      })),
    exit,
    ready: (terminalId) => {
      const worker = requireWorker(terminalId);
      worker.exited = false;
      processes.set(worker.processId, false);
    },
    move: (terminalId) => {
      const worker = requireWorker(terminalId);
      worker.paneId = `${worker.paneId}-moved`;

      return worker.paneId;
    },
    replaceSession: (terminalId, session) => {
      requireWorker(terminalId).session = session;
    },
    replaceProcess: (terminalId) => {
      requireWorker(terminalId).processId = startProcess();
    },
    processAbsent: (processId) => processes.get(processId) === true,
    knowsProcess: (processId) => processes.has(processId),
    processReply: (terminalId) => pinnedReply('processInfo', terminalId),
    processEvidence: (terminalId) => {
      const worker = workers.get(terminalId ?? '');

      if (worker === undefined) {
        return undefined;
      }

      return { processId: worker.processId, argv: worker.command };
    },
    agentReply: (terminalId) => {
      const queued = queuedAgentReplies.get(`${terminalId}`)?.shift();
      const pinned = pinnedReply('agent', terminalId);

      return queued ?? pinned;
    },
    queueAgentReplies: (terminalId, replies) => {
      queuedAgentReplies.set(terminalId, [...replies]);
    },
    malformedEvidence: (terminalId, surface, reply) => {
      const key = `${surface}:${terminalId}`;

      malformedReplies.set(key, [...(malformedReplies.get(key) ?? []), reply]);
    },
    holdReply: (terminalId, surface, reply) => {
      heldReplies.set(`${surface}:${terminalId}`, reply);
    },
  };
};
