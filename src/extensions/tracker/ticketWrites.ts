import { sameDescription } from '../../linear/descriptionMatch.js';
import type { TrackerRoute } from './config.js';

export interface TicketDraft {
  title: string;
  description: string;
}

export interface TicketArguments {
  directory: string;
  parent?: string;
  labels?: string[];
}

export interface TicketWrite {
  kind: 'createTicket' | 'updateTicket';
  text: string;
  title: string | undefined;
  description: string | undefined;
}

export interface TicketWriteFacts {
  draft: TicketDraft;
  request: TicketArguments;
  route: TrackerRoute | undefined;
  routeProblem: string;
  current: TicketDraft | null;
}

const planUpdate = (
  draft: TicketDraft,
  current: TicketDraft,
  request: TicketArguments,
): { writes: TicketWrite[]; problems: string[] } => {
  if (request.parent !== undefined) {
    return { writes: [], problems: ['parent is only accepted when creating a ticket.'] };
  }

  if (request.labels !== undefined) {
    return { writes: [], problems: ['labels is only accepted when creating a ticket.'] };
  }

  const title = current.title === draft.title ? undefined : draft.title;

  const description = sameDescription(current.description, draft.description)
    ? undefined
    : draft.description;

  if (title === undefined && description === undefined) {
    return { writes: [], problems: [] };
  }

  return {
    writes: [{ kind: 'updateTicket', text: `Update ${draft.title}.`, title, description }],
    problems: [],
  };
};

export const planTicketWrites = (
  facts: TicketWriteFacts,
): { writes: TicketWrite[]; problems: string[] } => {
  if (facts.route === undefined) {
    return { writes: [], problems: [facts.routeProblem] };
  }

  const { draft, current, request } = facts;

  if (draft.title.trim() === '') {
    return { writes: [], problems: ['title.md must contain a title.'] };
  }

  if (/[\r\n]/u.test(draft.title)) {
    return { writes: [], problems: ['title.md must contain one line.'] };
  }

  if (request.parent !== undefined && !/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(request.parent)) {
    return { writes: [], problems: ['parent must be a ticket identifier such as ME-12.'] };
  }

  if (current === null) {
    return {
      writes: [
        { kind: 'createTicket', text: `Create ${draft.title} in ${facts.route.team}.`, ...draft },
      ],
      problems: [],
    };
  }

  return planUpdate(draft, current, request);
};
