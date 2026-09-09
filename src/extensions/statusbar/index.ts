import { execFile } from 'node:child_process';
import { sep } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { footerTheme } from './colors.js';
import { renderFooterLine } from './render.js';

const exec = promisify(execFile);
const sessionCost = (ctx: ExtensionContext): number => {
  let cost = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
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
  let requestRender: (() => void) | undefined;
  let refreshId = 0;
  const refresh = async (ctx: ExtensionContext) => {
    const id = ++refreshId;
    let nextDirty = false;
    try {
      const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: ctx.cwd });
      nextDirty = stdout.length > 0;
    } catch {
      // Outside a repository, or when git fails, show no dirty marker.
    }
    // A slower earlier request must not replace a newer result or update a disposed footer.
    if (id !== refreshId) return;
    dirty = nextDirty;
    requestRender?.();
  };

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    await refresh(ctx);
    ctx.ui.setFooter((tui, _theme, footerData) => {
      requestRender = () => {
        tui.requestRender();
      };
      const unsubscribe = footerData.onBranchChange(() => {
        void refresh(ctx);
      });
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
          const usage = ctx.getContextUsage();
          return [
            renderFooterLine(
              {
                directory: ctx.cwd.split(sep).filter(Boolean).slice(-2).join(sep) || sep,
                branch: footerData.getGitBranch(),
                dirty,
                cost: sessionCost(ctx),
                contextPercent: usage?.percent ?? null,
                contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
                modelId: ctx.model?.id ?? 'no-model',
                thinkingLevel: ctx.model?.reasoning ? pi.getThinkingLevel() : undefined,
              },
              width,
              footerTheme,
            ),
          ];
        },
      };
    });
  });
  pi.on('tool_result', async (_event, ctx) => {
    if (ctx.mode === 'tui') await refresh(ctx);
  });
}
