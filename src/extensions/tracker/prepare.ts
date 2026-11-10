import { ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';
import { findDraftFor } from './draftRecord.js';
import type { DraftRecord } from './draftRecord.js';

interface PrepareDetails {
  directory: string;
  draft: DraftRecord | null;
  malformed: string[];
}

const idPattern = /^[a-z0-9][a-z0-9-]*$/;

export const prepare = async (cwd: string, id: unknown): Promise<PrepareDetails> => {
  if (typeof id !== 'string' || !idPattern.test(id)) {
    throw new Error(
      `Invalid id ${JSON.stringify(id)}: use lower-case letters, digits, and hyphens.`,
    );
  }

  const root = await findTauRoot(cwd, 'ticket');
  const found = await findDraftFor(root, id);
  const directory = await ensureTauDirectory(root, `tickets/${found.name}`);

  return { directory, draft: found.draft, malformed: found.malformed };
};
