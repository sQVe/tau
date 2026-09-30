import { estimateTokens, getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
  BoundaryResult,
  BoundaryState,
  CompactionEntryDraft,
  ExtensionContext,
  ExtensionUIContext,
  ProjectedSessionEntry,
} from '@earendil-works/pi-coding-agent';

import { loadCompactionConfig } from './config.js';
import { chooseFirstKeptEntry, shouldCompact } from './decision.js';
import type { ContextEntryFacts } from './decision.js';
import { summarizeManagerContext } from './summary.js';

// Worker records belong to the subagents extension, which passes this reader in.
export type WorkerLedgerReader = (
  context: ExtensionContext,
) => Promise<{ text: string; details: unknown }>;

const statusKey = 'tau-compaction';

const entryFacts = (entry: ProjectedSessionEntry): ContextEntryFacts => ({
  id: entry.sourceEntry.id,
  entryType: entry.sourceEntry.type,
  roles: entry.messages.map((message) => message.role),
  tokens: entry.messages.reduce((total, message) => total + estimateTokens(message), 0),
});

const messagesBefore = (entries: ProjectedSessionEntry[], firstKeptEntryId: string) => {
  const cut = entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);

  return entries
    .slice(0, cut)
    .flatMap((entry) => entry.messages)
    .filter((message) => message.role !== 'system');
};

const isDue = (
  event: BoundaryState,
  context: ExtensionContext,
  failedAtTokens: number | undefined,
): boolean => {
  const { thresholdTokens } = loadCompactionConfig({
    cwd: context.cwd,
    agentDirectory: getAgentDir(),
    projectTrusted: context.isProjectTrusted(),
  });

  return shouldCompact({
    outcome: event.outcome,
    aborted: context.signal?.aborted === true,
    compactionPending: event.entries.some((entry) => entry.type === 'compaction'),
    contextTokens: context.getContextUsage()?.tokens ?? undefined,
    thresholdTokens,
    failedAtTokens,
  });
};

// Returns what to summarize, or nothing when the context is below the threshold or has no cut.
const planFor = (
  event: BoundaryState,
  context: ExtensionContext,
  failedAtTokens: number | undefined,
) => {
  const model = context.model;

  if (model === undefined || !isDue(event, context, failedAtTokens)) {
    return undefined;
  }

  const entries = event.context.contextEntries;
  const firstKeptEntryId = chooseFirstKeptEntry(entries.map(entryFacts));

  if (firstKeptEntryId === undefined) {
    return undefined;
  }

  return {
    model,
    firstKeptEntryId,
    messages: messagesBefore(entries, firstKeptEntryId),
    contextTokens: context.getContextUsage()?.tokens ?? undefined,
  };
};

const draftFor = async (
  plan: NonNullable<ReturnType<typeof planFor>>,
  context: ExtensionContext,
  readWorkerLedger: WorkerLedgerReader,
  signal: AbortSignal,
): Promise<CompactionEntryDraft> => {
  const ledger = await readWorkerLedger(context);

  signal.throwIfAborted();

  const summary = await summarizeManagerContext(plan.messages, plan.model, context, signal);

  signal.throwIfAborted();

  return {
    type: 'compaction',
    summary: `${ledger.text}\n\n${summary.text}`,
    firstKeptEntryId: plan.firstKeptEntryId,
    details: ledger.details,
    usage: summary.usage,
  };
};

const failureNotice = (error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);

  return `Tau compaction failed: ${reason}. The session keeps its full context.`;
};

// Returns a compaction draft at an actionable boundary, or nothing. Pi saves the draft before the
// next model request without aborting the run. Any failure leaves the context as it is.
export const createCompactionBoundary = (readWorkerLedger: WorkerLedgerReader) => {
  let active: { controller: AbortController; ui: ExtensionUIContext } | undefined;
  let failedAtTokens: number | undefined;

  const compact = async (
    event: BoundaryState,
    context: ExtensionContext,
  ): Promise<BoundaryResult | undefined> => {
    const ui = context.ui;
    let plan: ReturnType<typeof planFor>;

    try {
      plan = planFor(event, context, failedAtTokens);
    } catch (error) {
      ui.notify(failureNotice(error), 'warning');

      return undefined;
    }

    if (plan === undefined) {
      return undefined;
    }

    // Shutdown aborts through the controller. A user abort reaches the summary only at `turn_end`:
    // at `agent_before_settle` the run has ended, Pi passes no signal, and it saves the draft.
    const controller = new AbortController();
    const runSignal = context.signal;

    const signal =
      runSignal === undefined ? controller.signal : AbortSignal.any([runSignal, controller.signal]);

    const current = { controller, ui };

    active = current;
    ui.setStatus(statusKey, 'Compacting context');

    try {
      const draft = await draftFor(plan, context, readWorkerLedger, signal);

      failedAtTokens = undefined;

      return { entries: [...event.entries, draft] };
    } catch (error) {
      if (!signal.aborted) {
        failedAtTokens = plan.contextTokens;
        ui.notify(failureNotice(error), 'warning');
      }

      return undefined;
    } finally {
      if (active === current) {
        active = undefined;
        ui.setStatus(statusKey, undefined);
      }
    }
  };

  const shutdown = () => {
    const current = active;

    active = undefined;
    current?.controller.abort(new Error('Session shut down during compaction.'));
    current?.ui.setStatus(statusKey, undefined);
  };

  const startSession = () => {
    failedAtTokens = undefined;
  };

  return { compact, shutdown, startSession };
};
