import type { HerdrClient } from '../src/extensions/subagents/controller/inspect.js';
import { placementFixture } from '../src/extensions/subagents/fixtures/placement.js';
import type { PlacementFixture } from '../src/extensions/subagents/fixtures/placement.js';
import { requireObject, result, text } from '../src/terminal.js';

interface ProcessSnapshot {
  paneId: string | undefined;
  shellPid: number;
  processId: number;
  argv: string[];
}

interface FakeWorker {
  paneId: string;
  terminalId: string;
  processId: number;
  session: string;
  exited: boolean;
}

interface HerdrFake {
  client: HerdrClient;
  calls: string[][];
  layout: PlacementFixture;
  workers: () => FakeWorker[];
  exit: (terminalId: string) => void;
  ready: (terminalId: string) => void;
  move: (terminalId: string) => void;
  replaceSession: (terminalId: string, session: string) => void;
  replaceProcess: (terminalId: string) => void;
  processAbsent: (processId: number) => boolean;
  knowsProcess: (processId: number) => boolean;
}

const shellProcessId = 100;
const firstWorkerProcessId = 5001;

// Response shapes were checked against herdr 0.9.1.
export const processInfoResponse = ({
  paneId,
  shellPid,
  processId,
  argv,
}: ProcessSnapshot): string =>
  JSON.stringify({
    result: {
      process_info: {
        pane_id: paneId,
        shell_pid: shellPid,
        foreground_process_group_id: processId,
        foreground_processes: [{ pid: processId, argv }],
      },
    },
  });

export const agentResponse = (agent: Record<string, unknown>): string =>
  JSON.stringify({ result: { agent } });

export const paneListResponse = (panes: Record<string, string>[]): string =>
  JSON.stringify({ result: { panes } });

const paneArgument = (argumentsList: string[]) =>
  argumentsList[argumentsList.indexOf('--pane') + 1];

const herdrError = (message: string, code: string) =>
  Object.assign(new Error(message), {
    stderr: JSON.stringify({ error: { code } }),
  });

/**
 * One stateful herdr fake: placement geometry plus Pi workers that each run as their pane's own
 * process. Tests change a worker only through the named transitions.
 */
export const herdrFake = (width = 200, height = 60): HerdrFake => {
  const layout = placementFixture(width, height);
  // A layout command runs as its pane's own process, keyed by terminal. It follows its terminal
  // when herdr moves the pane.
  const workers = new Map<string, FakeWorker & { command: string[] }>();
  const processes = new Map<number, boolean>([[shellProcessId, false]]);
  let nextProcessId = firstWorkerProcessId;
  const calls: string[][] = [];

  const terminalOf = (paneId: string | undefined) =>
    layout.panes.find((pane) => pane.pane_id === paneId)?.terminal_id;

  const workerOf = (paneId: string | undefined) => workers.get(terminalOf(paneId) ?? '');

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

  const processInfo = (argumentsList: string[]) => {
    const paneId = paneArgument(argumentsList);
    const worker = workerOf(paneId);

    // Any other pane runs a shell.
    return processInfoResponse({
      paneId,
      shellPid: worker?.processId ?? shellProcessId,
      processId: worker?.processId ?? shellProcessId,
      argv: worker?.command ?? ['shell'],
    });
  };

  const agentActions: Record<string, (argumentsList: string[]) => string> = {
    list: () => JSON.stringify({ result: { type: 'agent_list', agents: [] } }),
    get: (argumentsList) => {
      const worker = workerOf(argumentsList[2]);

      if (worker === undefined) {
        throw herdrError('agent target not found', 'agent_not_found');
      }

      return agentResponse({
        pane_id: argumentsList[2],
        agent: 'pi',
        agent_status: 'idle',
        agent_session: { kind: 'path', value: worker.session },
      });
    },
  };

  const exit = (terminalId: string) => {
    const worker = requireWorker(terminalId);
    worker.exited = true;
    processes.set(worker.processId, true);
  };

  // Herdr removes a command pane once its process exits.
  const removeExitedPanes = () => {
    const running = layout.panes.filter((pane) => workers.get(pane.terminal_id)?.exited !== true);

    layout.panes.splice(0, layout.panes.length, ...running);
  };

  const startWorker = (argumentsList: string[], response: string) => {
    const layoutRequest = JSON.parse(argumentsList[2] ?? '') as { root: { command: string[] } };
    const command = layoutRequest.root.command;

    const paneId = text(requireObject(requireObject(result(response).layout).root).pane_id);
    const terminalId = terminalOf(paneId) ?? '';

    workers.set(terminalId, {
      paneId,
      terminalId,
      processId: startProcess(),
      session: command[command.indexOf('--session') + 1] ?? '',
      exited: false,
      command,
    });
  };

  const client: HerdrClient = async (argumentsList) => {
    calls.push(argumentsList);
    removeExitedPanes();

    const [surface, action] = argumentsList;
    const agentAction = surface === 'agent' ? agentActions[action ?? ''] : undefined;

    if (agentAction !== undefined) {
      return agentAction(argumentsList);
    }

    if (action === 'process-info') {
      return processInfo(argumentsList);
    }

    if (surface === 'pane' && action === 'close') {
      const closing = workerOf(argumentsList[2]);

      if (closing !== undefined) {
        exit(closing.terminalId);
      }
    }

    const response = await layout.client(argumentsList);

    if (surface === 'layout') {
      startWorker(argumentsList, response);
    }

    return response;
  };

  return {
    client,
    calls,
    layout,
    workers: () =>
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
      const pane = layout.panes.find((candidate) => candidate.terminal_id === terminalId);

      worker.paneId = `${worker.paneId}-moved`;

      if (pane !== undefined) {
        pane.pane_id = worker.paneId;
      }
    },
    replaceSession: (terminalId, session) => {
      requireWorker(terminalId).session = session;
    },
    replaceProcess: (terminalId) => {
      requireWorker(terminalId).processId = startProcess();
    },
    processAbsent: (processId) => processes.get(processId) === true,
    knowsProcess: (processId) => processes.has(processId),
  };
};
