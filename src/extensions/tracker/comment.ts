import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { confirmWithUser } from '../../dialog/dialog.js';
import { isViewersTicket } from '../../linear/ownership.js';
import { ensureTauDirectory, findTauRoot, isSymlink } from '../../tauDirectory.js';
import { isWorkerProcess } from '../../worker.js';
import { decideCommentTarget } from './commentTarget.js';
import type { TicketComment } from './commentTarget.js';
import { findDraftFor, writeDraftRecord } from './draftRecord.js';
import { addComment, readComments, updateComment } from './linear.js';

export interface CommentRequest {
  ticket: string;
  heading: string;
  bodyFile: string;
}

export interface CommentDetails {
  status: 'added' | 'updated' | 'declined';
  id: string | null;
  url: string | null;
  directory: string;
  previousBody: string | null;
}

const approveComment = async (
  context: ExtensionContext,
  ticket: Awaited<ReturnType<typeof readComments>>,
  body: string,
  previousBody: string | null,
) => {
  if (isViewersTicket(ticket.viewer, ticket)) {
    return true;
  }

  if (!context.hasUI || isWorkerProcess()) {
    return false;
  }

  return confirmWithUser(context, {
    action: 'Commenting on a ticket another person owns',
    title: `Comment on ${ticket.identifier} in Linear`,
    message: `Previous comment:\n${previousBody ?? '(none)'}\n\nNew comment:\n${body}`,
  });
};

const rejectChangedComments = async (
  exec: Exec,
  context: ExtensionContext,
  ticket: Awaited<ReturnType<typeof readComments>>,
) => {
  if (isViewersTicket(ticket.viewer, ticket)) {
    return;
  }

  const current = await readComments(exec, context.cwd, ticket.identifier);

  if (!isDeepStrictEqual(current, ticket)) {
    throw new Error(
      'The ticket or comments changed while you answered. Call comment again. Nothing was written.',
    );
  }
};

const previousDetails = (previous: TicketComment | null) => ({
  id: previous?.id ?? null,
  url: previous?.url ?? null,
  previousBody: previous?.body ?? null,
});

export const comment = async (
  exec: Exec,
  context: ExtensionContext,
  request: CommentRequest,
): Promise<CommentDetails> => {
  const body = await readFile(resolve(context.cwd, request.bodyFile), 'utf8');

  if (body.split('\n')[0] !== request.heading) {
    throw new Error(
      `The first line of ${request.bodyFile} must be exactly ${JSON.stringify(request.heading)}.`,
    );
  }

  const root = await findTauRoot(context.cwd, 'ticket');
  const found = await findDraftFor(root, request.ticket.toLowerCase());
  const directory = join(root, '.tau', 'tickets', found.name);
  const recordPath = join(directory, 'draft.json');

  if (await isSymlink(recordPath)) {
    throw new Error(`Refusing to write through a symlink: ${recordPath}`);
  }

  const ticket = await readComments(exec, context.cwd, request.ticket);

  const target = decideCommentTarget({
    viewer: ticket.viewer,
    heading: request.heading,
    savedId: found.draft?.comments[request.heading],
    comments: ticket.comments,
  });

  if (target.kind === 'refuse') {
    throw new Error(
      `Several comments match ${JSON.stringify(request.heading)}: ${target.ids.join(', ')}. Nothing was written.`,
    );
  }

  const previous = target.kind === 'update' ? target.comment : null;
  const details = previousDetails(previous);
  const previousBody = details.previousBody;
  const approved = await approveComment(context, ticket, body, previousBody);

  if (!approved) {
    return {
      status: 'declined',
      ...details,
      directory,
    };
  }

  await rejectChangedComments(exec, context, ticket);
  await ensureTauDirectory(root, `tickets/${found.name}`);

  const saved =
    previous === null
      ? await addComment(exec, context.cwd, { issue: ticket.id, body })
      : await updateComment(exec, context.cwd, { id: previous.id, body });

  await writeDraftRecord(directory, {
    version: 3,
    identifier: found.draft?.identifier ?? ticket.identifier,
    comments: { ...found.draft?.comments, [request.heading]: saved.id },
  });

  const status = previous === null ? 'added' : 'updated';

  return { status, id: saved.id, url: saved.url, directory, previousBody };
};
