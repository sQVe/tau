import type { ToolDefinition, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../command.js';
import { cancel } from './cancel.js';
import type { CancelDetails } from './cancel.js';
import { comment } from './comment.js';
import type { CommentDetails } from './comment.js';
import { prepare } from './prepare.js';

type TicketDetails = Awaited<ReturnType<typeof prepare>> | CommentDetails | CancelDetails;

const parameters = Type.Object({
  action: Type.Union([Type.Literal('prepare'), Type.Literal('comment'), Type.Literal('cancel')]),
  id: Type.Optional(Type.String()),
  ticket: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9]*-[0-9]+$' })),
  heading: Type.Optional(Type.String({ minLength: 1 })),
  bodyFile: Type.Optional(Type.String({ minLength: 1 })),
});

type TicketInput = Static<typeof parameters>;

const requireText = (input: TicketInput, field: 'ticket' | 'heading' | 'bodyFile') => {
  const value = input[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${input.action} needs ${field}.`);
  }

  return value;
};

const executeAction = async (
  exec: Exec,
  context: ExtensionContext,
  input: TicketInput,
): Promise<TicketDetails> => {
  if (input.action === 'prepare') {
    return prepare(context.cwd, input.id);
  }

  const ticket = requireText(input, 'ticket');

  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(ticket)) {
    throw new Error(`Invalid ticket identifier ${JSON.stringify(ticket)}.`);
  }

  if (input.action === 'cancel') {
    return cancel(exec, context, ticket);
  }

  const heading = requireText(input, 'heading');
  const bodyFile = requireText(input, 'bodyFile');

  return comment(exec, context, { ticket, heading, bodyFile });
};

export const createTicketTool = (exec: Exec): ToolDefinition<typeof parameters, TicketDetails> =>
  defineTool({
    name: 'ticket',
    label: 'Ticket',
    description: `Prepare local ticket drafts, upsert comments, or cancel tickets.
- prepare {id}: find the draft that records the identifier whose lower case is id, or create .tau/tickets/<id> in the current checkout or bare repository root. id uses lower-case letters, digits, and hyphens. Returns {directory, draft, malformed}. directory is absolute; draft is the saved record or null; malformed lists unreadable drafts elsewhere. Keeps existing files.
- comment {ticket, heading, bodyFile}: add or update the viewer's comment. bodyFile is relative to the working directory or absolute, and its first line must equal heading. Uses the saved ID for that heading, then a single matching heading, then adds. Asks for approval when another person owns the ticket. Returns {status: "added" | "updated" | "declined", id, url, directory, previousBody}. previousBody is the replaced text for an update, else null. A declined update returns the target's id and url; a declined add returns null for both.
- cancel {ticket}: refuse completed tickets, merged PRs, and unreadable evidence. Already canceled returns unchanged. Otherwise asks for approval before canceling. Returns {status: "canceled" | "unchanged" | "declined", identifier}.
- Actions that need approval decline in workers or without UI. Refusals write nothing. Ticket identifiers use uppercase, such as ME-600.
- draft.json stores version 3, identifier, and comments keyed by exact heading. Older versions read with their saved review and quality IDs mapped to headings. Only this tool writes the record.`,
    promptSnippet: 'Prepare ticket drafts, upsert comments, or cancel tickets with checked guards.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, _signal, _onUpdate, context) {
      const details = await executeAction(exec, context, input);

      return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }], details };
    },
  });
