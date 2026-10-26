import { sep } from 'node:path';

import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import { runGit } from '../../git.js';
import { footerTheme, renderFooterLine } from './render.js';

type FooterFactory = NonNullable<Parameters<ExtensionContext['ui']['setFooter']>[0]>;

interface SessionKey {
  sessionId: string;
  leafId: string | null;
  entryCount: number;
}

interface CostReading extends SessionKey {
  cost: number;
}

interface ContextUsageReading extends SessionKey {
  model: ExtensionContext['model'];
  readAt: number;
  contextUsage: ContextUsage | undefined;
}

interface SessionStats {
  cost: CostReading;
  contextUsage: ContextUsageReading;
}

interface StatusbarState {
  dirty: boolean;
  requestRender: (() => void) | undefined;
  footerGeneration: number;
  refreshing: boolean;
  pendingContext: ExtensionContext | undefined;
}

// Bound background Git work. Failures leave the dirty marker hidden.
const gitTimeoutMilliseconds = 5000;
const shownDirectoryDepth = 2;
const contextUsageLifetimeMilliseconds = 1000;

const getSessionCost = (context: ExtensionContext): number => {
  let cost = 0;

  for (const entry of context.sessionManager.getEntries()) {
    if (entry.type === 'message') {
      if (entry.message.role === 'assistant' || entry.message.role === 'toolResult') {
        cost += entry.message.usage?.cost.total ?? 0;
      }
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      cost += entry.usage?.cost.total ?? 0;
    }
  }

  return cost;
};

// Pi passes its full session manager, which counts entries without copying them, but the
// extension type leaves the method out.
const countEntries = (
  sessionManager: ExtensionContext['sessionManager'] | SessionManager,
): number => {
  if ('getEntryCount' in sessionManager) {
    return sessionManager.getEntryCount();
  }

  return sessionManager.getEntries().length;
};

const sameSession = (cached: SessionKey | undefined, key: SessionKey): cached is SessionKey =>
  cached?.sessionId === key.sessionId &&
  cached.leafId === key.leafId &&
  cached.entryCount === key.entryCount;

const isFreshUsage = (
  cached: ContextUsageReading | undefined,
  now: number,
): cached is ContextUsageReading =>
  cached !== undefined && now - cached.readAt < contextUsageLifetimeMilliseconds;

// The footer renders on every frame, and both values scan the whole session. Entries are
// append-only and every append moves the leaf, so the cost changes only with the session, leaf, or
// entry count. Context usage also depends on the routed model's limits, which extensions cannot
// see, so it also expires after a second.
const readSessionStats = (
  context: ExtensionContext,
  cached: SessionStats | undefined,
  now: number,
): SessionStats => {
  const { sessionManager } = context;

  const key: SessionKey = {
    sessionId: sessionManager.getSessionId(),
    leafId: sessionManager.getLeafId(),
    entryCount: countEntries(sessionManager),
  };

  const cost = sameSession(cached?.cost, key)
    ? cached.cost
    : { ...key, cost: getSessionCost(context) };

  const cachedUsage = cached?.contextUsage;
  const reusable = isFreshUsage(cachedUsage, now) && sameSession(cachedUsage, key);

  const contextUsage =
    reusable && cachedUsage.model === context.model
      ? cachedUsage
      : { ...key, model: context.model, readAt: now, contextUsage: context.getContextUsage() };

  return { cost, contextUsage };
};

const readDirty = async (context: ExtensionContext): Promise<boolean> => {
  const result = await runGit(context.cwd, ['status', '--porcelain', '--untracked-files=normal'], {
    timeoutMilliseconds: gitTimeoutMilliseconds,
    environment: { GIT_OPTIONAL_LOCKS: '0' },
  });

  return result.exitCode === 0 && result.stdout.length > 0;
};

// Tool results arrive in bursts. Run one git status at a time and fold the requests that arrive
// meanwhile into a single rerun with the newest context.
const refreshDirty = async (state: StatusbarState, context: ExtensionContext): Promise<void> => {
  state.pendingContext = context;

  if (state.refreshing) {
    return;
  }

  state.refreshing = true;

  try {
    while (state.pendingContext !== undefined) {
      const current = state.pendingContext;

      state.pendingContext = undefined;
      const generation = state.footerGeneration;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Serial reruns are the point.
      const nextDirty = await readDirty(current);

      // Runs finish in order, so only a disposed footer makes a result stale.
      if (generation === state.footerGeneration) {
        state.dirty = nextDirty;
        state.requestRender?.();
      }
    }
  } finally {
    state.refreshing = false;
  }
};

const startRefresh = (state: StatusbarState, context: ExtensionContext): void => {
  // oxlint-disable-next-line typescript/no-floating-promises -- readDirty turns every git failure into a clean result, and requestRender only schedules a frame, so a refresh cannot reject.
  void refreshDirty(state, context);
};

const createFooter = (
  pi: ExtensionAPI,
  state: StatusbarState,
  context: ExtensionContext,
): FooterFactory => {
  return (terminal, _theme, footerData) => {
    state.dirty = false;

    state.requestRender = () => {
      terminal.requestRender();
    };

    const unsubscribe = footerData.onBranchChange(() => {
      startRefresh(state, context);
    });

    // Pi disposes the old footer before calling this factory. Start after that disposal.
    startRefresh(state, context);

    let stats: SessionStats | undefined;

    return {
      dispose() {
        unsubscribe();

        state.requestRender = undefined;
        state.footerGeneration += 1;
      },
      invalidate() {
        stats = undefined;
      },
      render(width) {
        // A monotonic clock, so a wall-clock rollback cannot keep context usage beyond its lifetime.
        stats = readSessionStats(context, stats, performance.now());
        const usage = stats.contextUsage.contextUsage;

        return [
          renderFooterLine(
            {
              directory:
                context.cwd.split(sep).filter(Boolean).slice(-shownDirectoryDepth).join(sep) || sep,
              branch: footerData.getGitBranch(),
              dirty: state.dirty,
              cost: stats.cost.cost,
              contextPercent: usage?.percent ?? null,
              contextWindow: usage?.contextWindow ?? context.model?.contextWindow ?? 0,
              modelId: context.model?.id ?? 'no-model',
              thinkingLevel: context.model?.reasoning === true ? pi.getThinkingLevel() : undefined,
            },
            width,
            footerTheme,
          ),
        ];
      },
    };
  };
};

export default function statusbarExtension(pi: ExtensionAPI): void {
  const state: StatusbarState = {
    dirty: false,
    requestRender: undefined,
    footerGeneration: 0,
    refreshing: false,
    pendingContext: undefined,
  };

  pi.on('session_start', (_event, context) => {
    if (context.mode !== 'tui') {
      return;
    }

    context.ui.setFooter(createFooter(pi, state, context));
  });

  // Pi awaits tool_result handlers, so footer reads must run in the background.
  pi.on('tool_result', (_event, context) => {
    if (context.mode === 'tui' && state.requestRender !== undefined) {
      startRefresh(state, context);
    }
  });
}
