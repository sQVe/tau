import {
  DEFAULT_COMPACTION_SETTINGS,
  generateSummaryWithUsage,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

type SummaryMessages = Parameters<typeof generateSummaryWithUsage>[0];

type SummaryModel = NonNullable<ExtensionContext['model']>;

const managerFocus = [
  'This is a Tau manager session that coordinates subagent workers. Keep these exactly:',
  '- the task scope, and what the user put out of scope;',
  '- what the user authorized or refused, such as commits, pushes, merges, and deletions;',
  '- each worktree path, branch, and baseline commit;',
  '- exact identifiers: ticket IDs, task IDs, question IDs, commit hashes, diff hashes, file paths, and check log paths;',
  '- each check that ran, its result, and its log path;',
  '- review findings and user questions that are still open.',
  'Tau rebuilds the "Tau worker ledger" section from saved records, so leave it out of your summary.',
].join('\n');

// The messages start with the previous summary when one exists, so the new summary carries it
// forward.
export const summarizeManagerContext = async (
  messages: SummaryMessages,
  model: SummaryModel,
  context: Pick<ExtensionContext, 'modelRegistry' | 'thinkingLevel'>,
  signal: AbortSignal,
) => {
  const registry = context.modelRegistry;

  // The registry resolves the session's credentials for each request.
  const streamThroughRegistry: Parameters<typeof generateSummaryWithUsage>[9] = (
    requestModel,
    request,
    options,
  ) => registry.streamSimple(requestModel, request, options);

  return generateSummaryWithUsage(
    messages,
    model,
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    undefined,
    undefined,
    signal,
    managerFocus,
    undefined,
    context.thinkingLevel,
    streamThroughRegistry,
  );
};
