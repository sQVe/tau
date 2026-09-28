import type { HerdrClient } from '../controller/inspect.js';
import { requireObject, result, text } from '../terminal.js';
import { placementFixture } from './placement.js';

interface ProcessSnapshot {
  paneId: string | undefined;
  shellPid: number;
  processId: number;
  argv: string[];
  foregroundProcesses?: { pid: number; argv: string[] }[];
}

// Response shapes were checked against herdr 0.9.1.
export const processInfoResponse = ({
  paneId,
  shellPid,
  processId,
  argv,
  foregroundProcesses,
}: ProcessSnapshot) =>
  JSON.stringify({
    result: {
      process_info: {
        pane_id: paneId,
        shell_pid: shellPid,
        foreground_process_group_id: processId,
        foreground_processes: foregroundProcesses ?? [{ pid: processId, argv }],
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
 * One stateful herdr fake: placement geometry plus agent state. Tests change
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
    nextReportedPaneId: undefined as string | undefined,
    foregroundProcessSamples: 0,
    foregroundProcessSamplesSeen: 0,
    lastForegroundProcessSampleCallIndex: -1,
    shell: process.ppid,
    process: process.pid,
  };

  const calls: string[][] = [];
  // Agents follow their terminal when herdr moves it to another pane.
  const agentTerminals = new Set<string>();
  // A layout command runs as its pane's own process, without a shell. Keyed by terminal.
  const commands = new Map<string, string[]>();

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
    const reportedPaneId = state.nextReportedPaneId ?? paneId;
    state.nextReportedPaneId = undefined;

    const foregroundProcesses =
      state.foregroundProcessSamples > 0
        ? [
            { pid: state.shell, argv: ['shell'] },
            { pid: state.process, argv: ['startup-hook'] },
          ]
        : undefined;

    if (foregroundProcesses !== undefined) {
      state.foregroundProcessSamples -= 1;
      state.foregroundProcessSamplesSeen += 1;
      state.lastForegroundProcessSampleCallIndex = calls.length - 1;
    }

    const running = hasAgent(paneId) && state.started && !state.stopped;
    const command = commands.get(terminalOf(paneId) ?? '');
    const direct = command !== undefined;

    if (!state.started && state.busyShellPolls > 0) {
      state.busyShellPolls -= 1;

      return processInfoResponse({
        paneId: reportedPaneId,
        shellPid: state.shell,
        processId: state.process,
        argv: ['shell-startup'],
        ...(foregroundProcesses === undefined ? {} : { foregroundProcesses }),
      });
    }

    return processInfoResponse({
      paneId: reportedPaneId,
      shellPid: direct ? state.process : state.shell,
      processId: running || direct ? state.process : state.shell,
      argv: command ?? state.processArguments,
      ...(foregroundProcesses === undefined ? {} : { foregroundProcesses }),
    });
  };

  const agentActions: Record<string, (argumentsList: string[]) => string> = {
    list: () => JSON.stringify({ result: { type: 'agent_list', agents: [] } }),
    start: (argumentsList) => {
      const timeout = Number(argumentsList[argumentsList.indexOf('--timeout') + 1]);

      if (!(timeout > 3000 && timeout <= 300_000)) {
        throw herdrError('agent start timeout out of range', 'invalid_agent_timeout');
      }

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

    // Herdr removes a command pane once its process exits.
    if (state.stopped) {
      const running = layout.panes.filter((pane) => !commands.has(pane.terminal_id));

      layout.panes.splice(0, layout.panes.length, ...running);
    }

    const [surface, action] = argumentsList;
    const agentAction = surface === 'agent' ? agentActions[action ?? ''] : undefined;

    if (agentAction !== undefined) {
      return agentAction(argumentsList);
    }

    if (action === 'process-info') {
      return processInfo(argumentsList);
    }

    if (
      surface === 'pane' &&
      action === 'close' &&
      commands.has(terminalOf(argumentsList[2]) ?? '')
    ) {
      state.stopped = true;
    }

    const response = await layout.client(argumentsList);

    if (surface === 'layout') {
      const params = JSON.parse(argumentsList[2] ?? '') as { root: { command: string[] } };
      const paneId = text(requireObject(requireObject(result(response).layout).root).pane_id);
      const terminal = terminalOf(paneId) ?? '';

      commands.set(terminal, params.root.command);
      agentTerminals.add(terminal);
      state.started = true;
      // The shared state follows the newest worker process.
      state.stopped = false;
    }

    return response;
  };

  return { client, state, calls, layout };
};
