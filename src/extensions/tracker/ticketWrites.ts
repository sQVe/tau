import { sameDescription } from '../../linear/descriptionMatch.js';
import type { TrackerRoute } from './config.js';
import type { TicketIssue } from './linear.js';

export interface TicketDraft {
  title: string;
  description: string;
}

export interface TicketArguments {
  directory: string;
  ticket?: string;
  parent?: string;
  labels?: string[];
}

interface CreateTicketWrite extends TicketDraft {
  kind: 'createTicket';
  text: string;
}

type TicketChanges =
  | { title: string; description: string | undefined }
  | { title: undefined; description: string };

type UpdateTicketWrite = TicketChanges & { kind: 'updateTicket'; text: string };

export type TicketWrite = CreateTicketWrite | UpdateTicketWrite;

export type TicketPlan =
  | { kind: 'blocked'; writes: []; problems: string[] }
  | { kind: 'unchanged'; current: TicketIssue; writes: []; problems: [] }
  | {
      kind: 'create';
      route: TrackerRoute;
      write: CreateTicketWrite;
      writes: [CreateTicketWrite];
      problems: [];
    }
  | {
      kind: 'update';
      current: TicketIssue;
      write: UpdateTicketWrite;
      writes: [UpdateTicketWrite];
      problems: [];
    };

interface TicketCandidate {
  identifier: string;
  title: string;
  creator: string | null;
  viewer: string;
}

export interface TicketWriteFacts {
  draft: TicketDraft;
  request: TicketArguments;
  route: TrackerRoute | undefined;
  routeProblem: string;
  current: TicketIssue | null;
  candidates: readonly TicketCandidate[];
  bindingProblem: string | undefined;
}

interface TicketBinding {
  identifier: string | null;
  problem: string | undefined;
}

export const resolveTicketBinding = (
  recordedIdentifier: string | null,
  requestedIdentifier: string | undefined,
): TicketBinding => {
  const conflicts =
    recordedIdentifier !== null &&
    requestedIdentifier !== undefined &&
    recordedIdentifier !== requestedIdentifier;

  if (conflicts) {
    return {
      identifier: recordedIdentifier,
      problem: `The ticket draft records ${recordedIdentifier}, not ${requestedIdentifier}.`,
    };
  }

  return { identifier: recordedIdentifier ?? requestedIdentifier ?? null, problem: undefined };
};

const blockedPlan = (problem: string): TicketPlan => ({
  kind: 'blocked',
  writes: [],
  problems: [problem],
});

const changedText = (draft: TicketDraft, current: TicketDraft): TicketChanges | undefined => {
  const description = sameDescription(current.description, draft.description)
    ? undefined
    : draft.description;

  if (current.title !== draft.title) {
    return { title: draft.title, description };
  }

  if (description !== undefined) {
    return { title: undefined, description };
  }

  return undefined;
};

const planUpdate = (
  draft: TicketDraft,
  current: TicketIssue,
  request: TicketArguments,
): TicketPlan => {
  if (request.parent !== undefined) {
    return blockedPlan('parent is only accepted when creating a ticket.');
  }

  if (request.labels !== undefined) {
    return blockedPlan('labels is only accepted when creating a ticket.');
  }

  const changes = changedText(draft, current);

  if (changes === undefined) {
    return { kind: 'unchanged', current, writes: [], problems: [] };
  }

  const write: UpdateTicketWrite = {
    kind: 'updateTicket',
    text: `Update ${draft.title}.`,
    ...changes,
  };

  return { kind: 'update', current, write, writes: [write], problems: [] };
};

const planCreate = (
  draft: TicketDraft,
  route: TrackerRoute,
  candidates: readonly TicketCandidate[],
): TicketPlan => {
  const matches = candidates
    .filter(
      (candidate) => candidate.title === draft.title && candidate.creator === candidate.viewer,
    )
    .map((candidate) => candidate.identifier);

  if (matches.length > 0) {
    return blockedPlan(
      `Open tickets you created already match this draft title: ${matches.join(', ')}. Resolve the unrecorded ticket before creating another.`,
    );
  }

  const write: CreateTicketWrite = {
    kind: 'createTicket',
    text: `Create ${draft.title} in ${route.team}.`,
    ...draft,
  };

  return { kind: 'create', route, write, writes: [write], problems: [] };
};

export const planTicketWrites = (facts: TicketWriteFacts): TicketPlan => {
  if (facts.bindingProblem !== undefined) {
    return blockedPlan(facts.bindingProblem);
  }

  if (facts.route === undefined) {
    return blockedPlan(facts.routeProblem);
  }

  const { draft, current, request } = facts;

  if (draft.title.trim() === '') {
    return blockedPlan('title.md must contain a title.');
  }

  if (/[\r\n]/u.test(draft.title)) {
    return blockedPlan('title.md must contain one line.');
  }

  if (request.parent !== undefined && !/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(request.parent)) {
    return blockedPlan('parent must be a ticket identifier such as ME-12.');
  }

  if (current === null) {
    return planCreate(draft, facts.route, facts.candidates);
  }

  return planUpdate(draft, current, request);
};
