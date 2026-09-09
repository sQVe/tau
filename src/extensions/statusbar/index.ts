import { execFile } from 'node:child_process';
import { sep } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { tddGateStatus } from '../tdd/state.js';
import { footerTheme } from './colors.js';
import { renderFooterLine } from './render.js';

const executeFile = promisify(execFile);

// Bound background Git work. Failures leave the dirty marker hidden.
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const getSessionCost = (context: ExtensionContext): number => {
  let cost = 0;

  for (const entry of context.sessionManager.getEntries()) {
    if (
      entry.type === 'message' &&
      (entry.message.role === 'assistant' || entry.message.role === 'toolResult')
    ) {
      cost += entry.message.usage?.cost.total ?? 0;
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      cost += entry.usage?.cost.total ?? 0;
    }
  }

  return cost;
};

export default function statusbarExtension(pi: ExtensionAPI) {
  let dirty = false;
  let tddGateOff = false;
  let requestRender: (() => void) | undefined;
  let refreshId = 0;

  const refresh = async (context: ExtensionContext) => {
    refreshId += 1;
    const currentRefreshId = refreshId;
    const gateStatus = tddGateStatus(context.cwd);
    let nextDirty = false;

    try {
      // Override status.showUntrackedFiles so new files always count as dirty.
      const { stdout } = await executeFile(
        'git',
        ['status', '--porcelain', '--untracked-files=normal'],
        {
          cwd: context.cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
        },
      );
      nextDirty = stdout.length > 0;
    } catch {
      // Outside a repository, or when git fails, show no dirty marker.
    }

    const nextTddGateOff = (await gateStatus) !== undefined;

    // Ignore results from older requests and disposed footers.
    if (currentRefreshId !== refreshId) {
      return;
    }

    dirty = nextDirty;
    tddGateOff = nextTddGateOff;
    requestRender?.();
  };

  pi.on('session_start', (_event, context) => {
    if (context.mode !== 'tui') {
      return;
    }

    context.ui.setFooter((terminal, _theme, footerData) => {
      dirty = false;
      tddGateOff = false;
      requestRender = () => {
        terminal.requestRender();
      };
      const unsubscribe = footerData.onBranchChange(() => {
        void refresh(context);
      });

      // Pi disposes the old footer before calling this factory. Start after that disposal.
      void refresh(context);

      return {
        dispose() {
          unsubscribe();
          requestRender = undefined;
          refreshId += 1;
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
                dirty,
                tddGateOff,
                cost: getSessionCost(context),
                contextPercent: usage?.percent ?? null,
                contextWindow: usage?.contextWindow ?? context.model?.contextWindow ?? 0,
                modelId: context.model?.id ?? 'no-model',
                thinkingLevel: context.model?.reasoning ? pi.getThinkingLevel() : undefined,
              },
              width,
              footerTheme,
            ),
          ];
        },
      };
    });
  });

  // Pi awaits tool_result handlers, so footer reads must run in the background.
  pi.on('tool_result', (_event, context) => {
    if (context.mode === 'tui' && requestRender !== undefined) {
      void refresh(context);
    }
  });
}
