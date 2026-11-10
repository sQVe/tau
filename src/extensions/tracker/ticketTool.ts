import type { ToolDefinition, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../command.js';
import { cancel } from './cancel.js';
import type { CancelDetails } from './cancel.js';
import { comment } from './comment.js';
import type { CommentDetails } from './comment.js';
import { prepare } from './prepare.js';
import { applyTicket, readTicket } from './ticketApply.js';

type TicketDetails =
  | Awaited<ReturnType<typeof prepare>>
  | CommentDetails
  | CancelDetails
  | Awaited<ReturnType<typeof readTicket>>
  | Awaited<ReturnType<typeof applyTicket>>;

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal('prepare'),
    Type.Literal('comment'),
    Type.Literal('cancel'),
    Type.Literal('read'),
    Type.Literal('apply'),
  ]),
  id: Type.Optional(Type.String()),
  directory: Type.Optional(Type.String({ minLength: 1 })),
  stateToken: Type.Optional(Type.String({ minLength: 1 })),
  parent: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9]*-[0-9]+$' })),
  labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  ticket: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9]*-[0-9]+$' })),
  heading: Type.Optional(Type.String({ minLength: 1 })),
  bodyFile: Type.Optional(Type.String({ minLength: 1 })),
});

type TicketInput = Static<typeof parameters>;

const requireText = (
  input: TicketInput,
  field: 'ticket' | 'heading' | 'bodyFile' | 'directory' | 'stateToken',
) => {
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

  if (input.action === 'read' || input.action === 'apply') {
    const request = {
      directory: requireText(input, 'directory'),
      ...(input.parent === undefined ? {} : { parent: input.parent }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
    };

    const runtime = {
      exec,
      context,
      location: {
        cwd: context.cwd,
        projectTrusted: context.isProjectTrusted(),
        agentDirectory: getAgentDir(),
      },
    };

    if (input.action === 'read') {
      return readTicket(runtime, request);
    }

    const stateToken = requireText(input, 'stateToken');

    return applyTicket(runtime, { ...request, stateToken });
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
    description: `Manage tickets and local drafts.
- prepare {id}: reuse a recorded ticket's draft or create .tau/tickets/<id>. id uses lower-case letters, digits, and hyphens. Returns {directory, draft, malformed}: absolute path, saved record or null, unreadable drafts elsewhere. Keeps existing files.
- read {directory, parent?, labels?}: plan from title.md and ticket.md using the repository route. parent is a ticket identifier; labels are label IDs. Both are create-only. Returns {directory, identifier, route, current, writes, problems, stateToken}. current is Linear text or null. Writes nothing.
- apply {directory, stateToken, parent?, labels?}: use read's token and arguments. Refuses changed state or problems. Saves a created identifier; updates only changed text. Returns {status: "created" | "updated" | "unchanged" | "declined", identifier, url}.
- comment {ticket, heading, bodyFile}: upsert the viewer's comment by saved ID or matching heading. bodyFile is absolute or relative to cwd; its first line must equal heading. Returns {status: "added" | "updated" | "declined", id, url, directory, previousBody}. previousBody is replaced text or null; declined returns the existing target's id and url, or null.
- cancel {ticket}: check ticket and PR state, then ask before canceling. Returns {status: "canceled" | "unchanged" | "declined", identifier}.
- Updates and comments on another person's ticket ask for approval. Approval declines in workers or without UI. Refusals write nothing. Use uppercase identifiers, such as ME-600. Only this tool writes draft.json.`,
    promptSnippet:
      'Prepare, read, and apply ticket drafts, upsert comments, or cancel tickets with checked guards.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, _signal, _onUpdate, context) {
      const details = await executeAction(exec, context, input);

      return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }], details };
    },
  });
