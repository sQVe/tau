import type { HerdrClient } from '../src/extensions/subagents/controller/inspect.js';
import { placementFixture } from '../src/extensions/subagents/fixtures/placement.js';
import type { PlacementFixture } from '../src/extensions/subagents/fixtures/placement.js';
import { requireObject, result, text } from '../src/herdr.js';
import { herdrWorkerFake, shellProcessId } from './herdrWorkerFake.js';
import type { FakeWorker, Reply, Surface } from './herdrWorkerFake.js';

interface ProcessSnapshot {
  paneId: string | undefined;
  shellPid: number;
  processId: number;
  argv: string[];
}

interface SeededWorker {
  paneId: string;
  terminalId: string;
  processId: number;
  session: string;
  argv: string[];
}

interface HerdrFake {
  client: HerdrClient;
  calls: string[][];
  layout: PlacementFixture;
  workers: () => FakeWorker[];
  seedWorker: (worker: SeededWorker) => void;
  queueAgentReplies: (terminalId: string, replies: Reply[]) => void;
  malformedEvidence: (terminalId: string, surface: Surface, reply: Reply) => void;
  holdReply: (terminalId: string, surface: Surface, reply: Reply) => void;
  exit: (terminalId: string) => void;
  ready: (terminalId: string) => void;
  move: (terminalId: string, tabId?: string) => void;
  replaceSession: (terminalId: string, session: string) => void;
  replaceProcess: (terminalId: string) => void;
  processAbsent: (processId: number) => boolean;
  knowsProcess: (processId: number) => boolean;
  addPane: (paneId: string, width: number) => void;
  zoom: () => void;
  focus: (tabId: string) => void;
  failCall: (step: string, error: Error, exitsTerminal?: boolean) => void;
  hangCall: (step: string) => void;
  beforeCall: (step: string, hook: () => void) => void;
  moveDuring: (step: string, tabId?: string) => void;
  exitWhenOpened: () => void;
  loseTabOnClose: (tabId: string) => void;
  malformedTabList: (reply: Reply) => void;
}

// Response shapes were checked against herdr 0.9.1.
const processInfoResponse = ({ paneId, shellPid, processId, argv }: ProcessSnapshot): string =>
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

const answer = (reply: Reply) => {
  if (reply instanceof Error) {
    throw reply;
  }

  return reply;
};

const paneArgument = (argumentsList: string[]) =>
  argumentsList[argumentsList.indexOf('--pane') + 1];

const paneNotFound = () => new Error('herdr failed: {"error":{"code":"pane_not_found"}}');

const tabNotFound = () => new Error('herdr failed: {"error":{"code":"tab_not_found"}}');

const hangUntilAborted = (signal: AbortSignal | undefined) =>
  new Promise<string>((_resolve, reject) => {
    if (signal === undefined) {
      reject(new Error('A hung call needs an abort signal.'));

      return;
    }

    const rejectWithReason = () => {
      reject(signal.reason as Error);
    };

    if (signal.aborted) {
      rejectWithReason();

      return;
    }

    signal.addEventListener('abort', rejectWithReason, { once: true });
  });

const valueOf = (argumentsList: string[], flag: string) =>
  argumentsList[argumentsList.indexOf(flag) + 1] ?? '';

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
  const fleet = herdrWorkerFake();
  const calls: string[][] = [];
  const malformedTabLists: Reply[] = [];
  // Faults keyed by the call they hit, such as `pane run`.
  const failures = new Map<string, { error: Error; exitsTerminal: boolean }>();
  const hungSteps = new Set<string>();
  const hooks = new Map<string, () => void>();
  const movingSteps = new Map<string, string | undefined>();
  const lostTabs = new Set<string>();
  let focusedTab = layout.parent.tab_id;
  let openedCount = 0;
  let opensExited = false;

  const terminalOf = (paneId: string | undefined) =>
    layout.panes.find((pane) => pane.pane_id === paneId)?.terminal_id;

  const processInfo = (argumentsList: string[]) => {
    const paneId = paneArgument(argumentsList);
    const terminalId = terminalOf(paneId);
    const pinned = fleet.processReply(terminalId);

    if (pinned !== undefined) {
      return answer(pinned);
    }

    // Any other pane runs a shell.
    const evidence = fleet.processEvidence(terminalId);

    return processInfoResponse({
      paneId,
      shellPid: evidence?.shellProcessId ?? shellProcessId,
      processId: evidence?.processId ?? shellProcessId,
      argv: evidence?.argv ?? ['shell'],
    });
  };

  const agentActions: Record<string, (argumentsList: string[]) => string> = {
    list: () => JSON.stringify({ result: { type: 'agent_list', agents: [] } }),
    get: (argumentsList) => {
      const worker = fleet.find(terminalOf(argumentsList[2]));
      const pinned = fleet.agentReply(terminalOf(argumentsList[2]));

      if (pinned !== undefined) {
        return answer(pinned);
      }

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

  // Herdr removes a command pane once its process exits.
  const removeExitedPanes = () => {
    const running = layout.panes.filter((pane) => !fleet.isExited(pane.terminal_id));

    layout.panes.splice(0, layout.panes.length, ...running);
  };

  const tabIds = () => [...new Set(layout.panes.map((pane) => pane.tab_id))];

  const startReview = (pane: (typeof layout.panes)[number]) => {
    layout.dimensions.set(pane.pane_id, {
      ...layout.dimensions.get(layout.parent.pane_id)!,
    });

    fleet.register({
      paneId: pane.pane_id,
      terminalId: pane.terminal_id,
      session: '',
      command: ['tuicr'],
      runsInShell: true,
    });

    if (opensExited) {
      fleet.exit(pane.terminal_id);
    }
  };

  const openedPane = (tabId: string, workspaceId: string) => {
    openedCount += 1;

    const pane = {
      ...layout.parent,
      pane_id: `review-pane-${openedCount}`,
      terminal_id: `review-terminal-${openedCount}`,
      workspace_id: workspaceId,
      tab_id: tabId,
    };

    layout.panes.push(pane);
    startReview(pane);

    return pane;
  };

  const closeTab = (tabId: string) => {
    const doomed = layout.panes.filter((pane) => pane.tab_id === tabId);

    const lost = lostTabs.delete(tabId);

    for (const pane of doomed) {
      if (fleet.has(pane.terminal_id)) {
        fleet.exit(pane.terminal_id);
      }
    }

    removeExitedPanes();

    if (lost || doomed.length === 0) {
      throw tabNotFound();
    }

    if (focusedTab === tabId) {
      focusedTab = layout.panes[0]?.tab_id ?? tabId;
    }

    return '{}';
  };

  const reviewActions: Record<string, (argumentsList: string[]) => string> = {
    'pane split': (argumentsList) => {
      const target = layout.panes.find((pane) => pane.pane_id === valueOf(argumentsList, '--pane'));

      if (target === undefined) {
        throw paneNotFound();
      }

      return JSON.stringify({
        result: { pane: openedPane(target.tab_id, target.workspace_id) },
      });
    },
    'tab create': (argumentsList) => {
      const tabId = `review-tab-${openedCount + 1}`;
      const pane = openedPane(tabId, valueOf(argumentsList, '--workspace'));
      focusedTab = tabId;

      return JSON.stringify({
        result: { tab: { tab_id: tabId }, root_pane: pane },
      });
    },
    'tab list': () => {
      const malformed = malformedTabLists.shift();

      if (malformed !== undefined) {
        return answer(malformed);
      }

      const tabs = tabIds().map((tabId) => ({
        tab_id: tabId,
        focused: tabId === focusedTab,
      }));

      return JSON.stringify({ result: { tabs } });
    },
    'tab focus': (argumentsList) => {
      focusedTab = argumentsList[2] ?? focusedTab;

      return '{}';
    },
    'tab close': (argumentsList) => closeTab(argumentsList[2] ?? ''),
    'pane run': (argumentsList) => {
      if (terminalOf(argumentsList[2]) === undefined) {
        throw paneNotFound();
      }

      return '{}';
    },
  };

  const targetTerminal = (argumentsList: string[]) =>
    terminalOf(paneArgument(argumentsList)) ?? terminalOf(argumentsList[2]);

  const move = (terminalId: string, tabId?: string) => {
    const movedPaneId = fleet.move(terminalId);
    const pane = layout.panes.find((candidate) => candidate.terminal_id === terminalId);

    if (pane !== undefined) {
      pane.pane_id = movedPaneId;
      pane.tab_id = tabId ?? pane.tab_id;
    }
  };

  // Applies the faults a test set for this call. A fault throws or hangs; otherwise the call goes on.
  const interrupt = async (step: string, argumentsList: string[], signal?: AbortSignal) => {
    hooks.get(step)?.();

    if (hungSteps.has(step)) {
      await hangUntilAborted(signal);
    }

    const terminalId = targetTerminal(argumentsList);

    if (movingSteps.has(step) && terminalId !== undefined) {
      const tabId = movingSteps.get(step);
      movingSteps.delete(step);
      move(terminalId, tabId);

      throw paneNotFound();
    }

    const failure = failures.get(step);

    if (failure !== undefined) {
      if (failure.exitsTerminal && terminalId !== undefined) {
        fleet.exit(terminalId);
      }

      throw failure.error;
    }
  };

  const startWorker = (argumentsList: string[], response: string) => {
    const layoutRequest = JSON.parse(argumentsList[2] ?? '') as {
      root: { command: string[] };
    };

    const command = layoutRequest.root.command;

    const paneId = text(requireObject(requireObject(result(response).layout).root).pane_id);
    const terminalId = terminalOf(paneId) ?? '';

    fleet.register({
      paneId,
      terminalId,
      session: command[command.indexOf('--session') + 1] ?? '',
      command,
    });
  };

  const client: HerdrClient = async (argumentsList, _budget, signal) => {
    calls.push(argumentsList);
    removeExitedPanes();

    const [surface, action] = argumentsList;
    const step = `${surface} ${action}`;
    await interrupt(step, argumentsList, signal);

    const reviewAction = reviewActions[step];

    if (reviewAction !== undefined) {
      return reviewAction(argumentsList);
    }

    const agentAction = surface === 'agent' ? agentActions[action ?? ''] : undefined;

    if (agentAction !== undefined) {
      return agentAction(argumentsList);
    }

    if (action === 'process-info') {
      return processInfo(argumentsList);
    }

    if (surface === 'pane' && action === 'get' && terminalOf(argumentsList[2]) === undefined) {
      throw herdrError('pane not found', 'pane_not_found');
    }

    if (surface === 'pane' && action === 'close') {
      const closing = fleet.find(terminalOf(argumentsList[2]));

      if (closing !== undefined) {
        fleet.exit(closing.terminalId);
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
    workers: fleet.snapshot,
    seedWorker: ({ paneId, terminalId, processId, session, argv }) => {
      layout.panes.push({
        ...layout.parent,
        pane_id: paneId,
        terminal_id: terminalId,
      });

      fleet.register({ paneId, terminalId, processId, session, command: argv });
    },
    queueAgentReplies: fleet.queueAgentReplies,
    malformedEvidence: fleet.malformedEvidence,
    holdReply: fleet.holdReply,
    exit: fleet.exit,
    ready: fleet.ready,
    move,
    replaceSession: fleet.replaceSession,
    replaceProcess: fleet.replaceProcess,
    addPane: (paneId, paneWidth) => {
      // Listed before the agent pane, so a lookup that takes the first pane gets the wrong one.
      layout.panes.unshift({
        ...layout.parent,
        pane_id: paneId,
        terminal_id: `${paneId}-terminal`,
      });

      layout.dimensions.set(paneId, {
        width: paneWidth,
        height: layout.dimensions.get(layout.parent.pane_id)!.height,
      });
    },
    zoom: () => {
      layout.view.zoomed = true;
    },
    focus: (tabId) => {
      focusedTab = tabId;
    },
    failCall: (step, error, exitsTerminal = false) => {
      failures.set(step, { error, exitsTerminal });
    },
    beforeCall: (step, hook) => {
      hooks.set(step, hook);
    },
    hangCall: (step) => {
      hungSteps.add(step);
    },
    moveDuring: (step, tabId) => {
      movingSteps.set(step, tabId);
    },
    exitWhenOpened: () => {
      opensExited = true;
    },
    loseTabOnClose: (tabId) => {
      lostTabs.add(tabId);
    },
    malformedTabList: (reply) => {
      malformedTabLists.push(reply);
    },
    processAbsent: fleet.processAbsent,
    knowsProcess: fleet.knowsProcess,
  };
};
