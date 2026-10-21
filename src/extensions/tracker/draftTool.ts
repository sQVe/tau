import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';
import type { DraftRecord } from './draftRecord.js';
import { checkDraftField, findDraftFor, writeDraftField } from './draftRecord.js';

interface PrepareDetails {
  directory: string;
  draft: DraftRecord | null;
  malformed: string[];
}

interface RecordDetails {
  directory: string;
  draft: DraftRecord;
}

const parameters = Type.Union([
  Type.Object({ action: Type.Literal('prepare'), id: Type.String() }),
  Type.Object({
    action: Type.Literal('record'),
    id: Type.String(),
    field: Type.Union([
      Type.Literal('identifier'),
      Type.Literal('reviewCommentId'),
      Type.Literal('qualityCommentId'),
    ]),
    value: Type.String(),
  }),
]);

const idPattern = /^[a-z0-9][a-z0-9-]*$/;

const prepare = async (cwd: string, id: unknown): Promise<PrepareDetails> => {
  if (typeof id !== 'string' || !idPattern.test(id)) {
    throw new Error(
      `Invalid id ${JSON.stringify(id)}: use lower-case letters, digits, and hyphens.`,
    );
  }

  const root = await findTauRoot(cwd, 'tracker_draft');

  const found = await findDraftFor(root, id);
  const directory = await ensureTauDirectory(root, `tickets/${found.name}`);

  return { directory, draft: found.draft, malformed: found.malformed };
};

const record = async (
  cwd: string,
  id: unknown,
  field: string,
  value: unknown,
): Promise<RecordDetails> => {
  checkDraftField(field, value);

  const { directory } = await prepare(cwd, id);
  const draft = await writeDraftField(directory, field, value);

  return { directory, draft };
};

export const createTrackerDraftTool = (): ToolDefinition<
  typeof parameters,
  PrepareDetails | RecordDetails
> =>
  defineTool({
    name: 'tracker_draft',
    label: 'Tracker draft',
    description: `Prepare a directory that holds a ticket draft, and record IDs in its draft.json.
- action prepare with id: finds the .tau/tickets/*/draft.json that records the identifier whose lower case is id, or else creates or reuses .tau/tickets/<id>, in the current checkout or bare repository root, and ensures .tau/.gitignore ends with *. Returns {directory, draft, malformed}: directory is an absolute path, draft is the parsed draft.json of that directory or null when it has none, and malformed lists the draft.json paths in other directories that cannot be read. Keeps existing files.
- draft.json is {"version": 2, "identifier": "ME-600" or null, "reviewCommentId": a Linear comment ID or null, "qualityCommentId": a Linear comment ID or null}. A version 1 record reads with qualityCommentId null.
- action record with id, field, and value: finds the directory as prepare does, sets one field of its draft.json to value, keeps every other field, and writes a version 2 record. field is identifier (a ticket identifier such as ME-600), reviewCommentId, or qualityCommentId (a non-empty Linear comment ID). Creates draft.json with the other fields null when the directory has none. Returns {directory, draft} with the written record. Writes nothing when the record is malformed or newer, or the field or value is invalid.
- id matches ^[a-z0-9][a-z0-9-]*$, such as a lower-case ticket identifier (me-600) or a slug of the title. Nested calls resolve to the same root.
- Errors: a missing or invalid id, a malformed or newer draft.json in the returned directory, or two directories that record the same identifier (nothing is created in these cases), no Git repository, an unresolved bare Git directory, a symlink in the directory path, a hard-linked .tau/.gitignore, or a tracked destination or ignore file in a worktree.
- Writes nothing to the tracker. The directory is created only by prepare or record.`,
    promptSnippet: 'Prepare the local directory for a ticket draft.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, toolParameters, _signal, _onUpdate, context) {
      const details =
        toolParameters.action === 'record'
          ? await record(context.cwd, toolParameters.id, toolParameters.field, toolParameters.value)
          : await prepare(context.cwd, toolParameters.id);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
