import { execFile } from 'node:child_process';
import { sep } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { footerTheme } from './colors.js';
import { renderFooterLine } from './render.js';

type FooterFactory = NonNullable<Parameters<ExtensionContext['ui']['setFooter']>[0]>;

interface StatusbarState {
  dirty: boolean;
  requestRender: (() => void) | undefined;
  footerGeneration: number;
  refreshing: boolean;
  pendingContext: ExtensionContext | undefined;
}

const executeFile = promisify(execFile);

// Bound background Git work. Failures leave the dirty marker hidden.
const gitTimeoutMilliseconds = 5000;
const gitMaximumBufferBytes = 10 * 1024 * 1024;

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

const readDirty = async (context: ExtensionContext): Promise<boolean> => {
  try {
    // Override status.showUntrackedFiles so new files always count as dirty.
    const { stdout } = await executeFile(
      'git',
      ['status', '--porcelain', '--untracked-files=normal'],
      {
        cwd: context.cwd,
        // oxlint-disable-next-line node/no-process-env -- Status inherits Git configuration but must not lock the index.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        timeout: gitTimeoutMilliseconds,
        maxBuffer: gitMaximumBufferBytes,
      },
    );

    return stdout.length > 0;
  } catch {
    // Outside a repository, or when git fails, show no dirty marker.
    return false;
  }
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
      void refreshDirty(state, context);
    });

    // Pi disposes the old footer before calling this factory. Start after that disposal.
    void refreshDirty(state, context);

    return {
      dispose() {
        unsubscribe();

        state.requestRender = undefined;
        state.footerGeneration += 1;
      },
      invalidate() {
        // No render cache: session values are read on every render.
      },
      render(width) {
        const usage = context.getContextUsage();

        return [
          renderFooterLine(
            {
              directory: context.cwd.split(sep).filter(Boolean).slice(-2).join(sep) || sep,
              branch: footerData.getGitBranch(),
              dirty: state.dirty,
              cost: getSessionCost(context),
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

export default function statusbarExtension(pi: ExtensionAPI) {
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
      void refreshDirty(state, context);
    }
  });
}
