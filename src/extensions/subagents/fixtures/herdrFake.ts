import type { HerdrClient } from '../controller.js';
import { placementFixture } from './layout.js';

interface ProcessSnapshot {
  paneId: string | undefined;
  shellPid: number;
  processId: number;
  argv: string[];
}

// Response shapes were checked against herdr 0.9.1.
export const processInfoResponse = ({ paneId, shellPid, processId, argv }: ProcessSnapshot) =>
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

export const agentResponse = (agent: Record<string, unknown>) =>
  JSON.stringify({ result: { agent } });

export const paneListResponse = (panes: Record<string, string>[]) =>
  JSON.stringify({ result: { panes } });

const paneArgument = (argumentsList: string[]) =>
  argumentsList[argumentsList.indexOf('--pane') + 1];

const herdrError = (message: string, code?: string) =>
  Object.assign(new Error(message), {
    stderr: code === undefined ? '' : JSON.stringify({ error: { code } }),
  });

/**
 * One stateful herdr fake: real pane layout from placementFixture plus agent state. Tests change
 * `state` to inject faults.
 */
// ponytail: every worker pane shares one agent state. Keep state per pane when a test needs two
// workers that differ.
export const herdrFake = (kind: string, width = 200, height = 60) => {
  const layout = placementFixture(width, height);
  const state = {
    busyShellPolls: 0,
    started: false,
    stopped: false,
    status: 'idle',
    kind,
    startError: '',
    rejectStart: false,
    promptError: '',
    promptBlocked: false,
    sendKeysError: '',
    inspectionError: '',
    ignoreInterrupt: false,
    session: 'opaque-reference',
    processArguments: [kind],
    shell: process.ppid,
    process: process.pid,
  };
  const calls: string[][] = [];
  // Agents follow their terminal when herdr moves it to another pane.
  const agentTerminals = new Set<string>();
  const terminalOf = (paneId: string | undefined) =>
    layout.panes.find((pane) => pane.pane_id === paneId)?.terminal_id;
  const hasAgent = (paneId: string | undefined) => agentTerminals.has(terminalOf(paneId) ?? '');
  const addAgent = (argumentsList: string[]) => {
    const terminal = terminalOf(paneArgument(argumentsList));

    if (terminal === undefined) {
      throw herdrError('pane not found', 'pane_not_found');
    }

    agentTerminals.add(terminal);
  };

  const processInfo = (argumentsList: string[]) => {
    const paneId = paneArgument(argumentsList);
    const running = hasAgent(paneId) && state.started && !state.stopped;

    if (!state.started && state.busyShellPolls > 0) {
      state.busyShellPolls -= 1;

      return processInfoResponse({
        paneId,
        shellPid: state.shell,
        processId: state.process,
        argv: ['shell-startup'],
      });
    }

    return processInfoResponse({
      paneId,
      shellPid: state.shell,
      processId: running ? state.process : state.shell,
      argv: state.processArguments,
    });
  };

  const agentActions: Record<string, (argumentsList: string[]) => string> = {
    list: () => JSON.stringify({ result: { type: 'agent_list', agents: [] } }),
    read: () => JSON.stringify({ result: { text: 'A bounded native question or approval.' } }),
    start: (argumentsList) => {
      if (state.busyShellPolls > 0) {
        throw herdrError('Shell is still starting', 'agent_pane_busy');
      }

      if (state.startError) {
        state.started = !state.rejectStart;

        if (state.started) {
          addAgent(argumentsList);
        }

        throw new Error(state.startError);
      }

      addAgent(argumentsList);
      state.started = true;

      return JSON.stringify({ result: {} });
    },
    get: (argumentsList) => {
      if (state.inspectionError) {
        throw new Error(state.inspectionError);
      }

      if (state.rejectStart || !hasAgent(argumentsList[2])) {
        throw herdrError('agent target not found', 'agent_not_found');
      }

      return agentResponse({
        pane_id: argumentsList[2],
        agent: state.kind,
        agent_status: state.status,
        agent_session: state.session ? { kind: 'id', value: state.session } : null,
      });
    },
    prompt: (argumentsList) => {
      // Real herdr rejects '--' as text; a separator here would fail delivery.
      if (argumentsList[3] === '--') {
        throw new Error('unknown option: text');
      }

      if (state.promptError) {
        throw herdrError(state.promptError, state.promptBlocked ? 'agent_blocked' : undefined);
      }

      return JSON.stringify({ result: {} });
    },
    'send-keys': () => {
      if (state.sendKeysError) {
        throw new Error(state.sendKeysError);
      }

      if (!state.ignoreInterrupt) {
        state.stopped = true;
      }

      return JSON.stringify({ result: {} });
    },
  };

  const client: HerdrClient = async (argumentsList) => {
    calls.push(argumentsList);
    const [surface, action] = argumentsList;
    const agentAction = surface === 'agent' ? agentActions[action ?? ''] : undefined;

    if (agentAction !== undefined) {
      return agentAction(argumentsList);
    }

    return action === 'process-info' ? processInfo(argumentsList) : layout.client(argumentsList);
  };

  return { client, state, calls, layout };
};
