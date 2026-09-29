import type { HerdrClient } from '../controller/inspect.js';
import { requireObject, result, text } from '../terminal.js';
import { placementFixture } from './placement.js';

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

const herdrError = (message: string, code: string) =>
  Object.assign(new Error(message), { stderr: JSON.stringify({ error: { code } }) });

/**
 * One stateful herdr fake: placement geometry plus Pi workers that run as their pane's own
 * process. Tests change `state` to inject faults.
 */
// ponytail: every worker pane shares one worker state. Keep state per pane when a test needs two
// workers that differ.
export const herdrFake = (width = 200, height = 60) => {
  const layout = placementFixture(width, height);

  const state = {
    stopped: false,
    session: 'opaque-reference',
    process: process.pid,
  };

  const calls: string[][] = [];
  // A layout command runs as its pane's own process, keyed by terminal. It follows its terminal
  // when herdr moves the pane.
  const commands = new Map<string, string[]>();

  const terminalOf = (paneId: string | undefined) =>
    layout.panes.find((pane) => pane.pane_id === paneId)?.terminal_id;

  const processInfo = (argumentsList: string[]) => {
    const paneId = paneArgument(argumentsList);
    const command = commands.get(terminalOf(paneId) ?? '');

    // Any other pane runs a shell.
    return processInfoResponse({
      paneId,
      shellPid: command ? state.process : 100,
      processId: command ? state.process : 100,
      argv: command ?? ['shell'],
    });
  };

  const agentActions: Record<string, (argumentsList: string[]) => string> = {
    list: () => JSON.stringify({ result: { type: 'agent_list', agents: [] } }),
    get: (argumentsList) => {
      if (!commands.has(terminalOf(argumentsList[2]) ?? '')) {
        throw herdrError('agent target not found', 'agent_not_found');
      }

      return agentResponse({
        pane_id: argumentsList[2],
        agent: 'pi',
        agent_status: 'idle',
        agent_session: { kind: 'path', value: state.session },
      });
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

      commands.set(terminalOf(paneId) ?? '', params.root.command);
      // The shared state follows the newest worker process.
      state.stopped = false;
    }

    return response;
  };

  return { client, state, calls, layout };
};
