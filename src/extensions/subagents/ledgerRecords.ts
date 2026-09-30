import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { searchHistory } from './history.js';
import { buildLedger, renderLedger } from './ledger.js';
import type { Ledger } from './ledger.js';

type Ownership = (taskId: string) => boolean;

// Reads the saved workers of the current session tree. An unreadable record becomes a diagnostic;
// unreadable session ancestry throws.
export const readWorkerLedger = async (
  root: string,
  session: { file: string; id: string; sessionDirectory: string },
  ownership: Ownership,
): Promise<Ledger> => {
  const history = await searchHistory(root, session, '', ownership);

  return buildLedger(history.candidates, history.diagnostics);
};

const sessionLedger = async (
  context: Pick<ExtensionContext, 'sessionManager'>,
  root: string,
  ownership: Ownership,
): Promise<Ledger> => {
  const file = context.sessionManager.getSessionFile();

  // Workers need a saved parent session, so a session without a file has none.
  if (file == null || file === '') {
    return buildLedger([], []);
  }

  const session = {
    file,
    id: context.sessionManager.getSessionId(),
    sessionDirectory: context.sessionManager.getSessionDir(),
  };

  return readWorkerLedger(root, session, ownership);
};

// The text leads the compaction summary; the structured ledger is saved with it.
export const readSessionLedger = async (
  context: Pick<ExtensionContext, 'sessionManager'>,
  root: string,
  ownership: Ownership,
) => {
  const ledger = await sessionLedger(context, root, ownership);

  return { text: renderLedger(ledger), details: ledger };
};
