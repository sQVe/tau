import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { searchHistory } from './history.js';
import { buildLedger } from './ledger.js';
import type { Ledger } from './ledger.js';

type Ownership = (taskId: string) => boolean;

type SessionReader = Pick<
  ExtensionContext['sessionManager'],
  'getSessionFile' | 'getSessionId' | 'getSessionDir'
>;

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

// Workers need a saved parent session, so a session without a file has none.
export const readSessionLedger = async (
  context: { sessionManager: SessionReader },
  root: string,
  ownership: Ownership,
): Promise<Ledger> => {
  const file = context.sessionManager.getSessionFile();

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
