import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import { footerTheme, renderFooterLine } from './render.js';
import { decideReuse } from './reuseDecision.js';
import type { SessionKey } from './reuseDecision.js';

type FooterFactory = NonNullable<Parameters<ExtensionContext['ui']['setFooter']>[0]>;

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

const getSessionCost = (context: ExtensionContext): number => {
  let cost = 0;

  for (const entry of context.sessionManager.getEntries()) {
    if (entry.type === 'message') {
      if (entry.message.role === 'assistant' || entry.message.role === 'toolResult') {
        cost += entry.message.usage?.cost.total ?? 0;
      }
    } else if (entry.type === 'usage') {
      cost += entry.usage.cost.total;
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      cost += entry.usage?.cost.total ?? 0;
    }
  }

  return cost;
};

const countEntries = (
  sessionManager: ExtensionContext['sessionManager'] | SessionManager,
): number => {
  if ('getEntryCount' in sessionManager) {
    return sessionManager.getEntryCount();
  }

  return sessionManager.getEntries().length;
};

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

  const cachedUsage = cached?.contextUsage;
  const usageAgeMilliseconds = cachedUsage === undefined ? undefined : now - cachedUsage.readAt;

  const decision = decideReuse({
    current: key,
    cachedCost: cached?.cost,
    cachedUsage,
    usageAgeMilliseconds,
    modelUnchanged: cachedUsage?.model === context.model,
  });

  const cost =
    decision.cost && cached !== undefined ? cached.cost : { ...key, cost: getSessionCost(context) };

  const contextUsage =
    decision.contextUsage && cachedUsage !== undefined
      ? cachedUsage
      : { ...key, model: context.model, readAt: now, contextUsage: context.getContextUsage() };

  return { cost, contextUsage };
};

export const createFooter = (pi: ExtensionAPI, context: ExtensionContext): FooterFactory => {
  return () => {
    let stats: SessionStats | undefined;

    return {
      invalidate() {
        stats = undefined;
      },
      render(width) {
        stats = readSessionStats(context, stats, performance.now());
        const usage = stats.contextUsage.contextUsage;

        return [
          renderFooterLine(
            {
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
