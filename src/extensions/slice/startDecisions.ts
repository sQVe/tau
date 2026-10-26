import { isViewersTicket } from './ownership.js';
import { sameDescription } from './writes.js';

export interface TicketFact {
  title: string;
  identifier: string | null;
  body: string;
}

export interface ChildFact {
  identifier: string;
  title: string;
  description: string;
  team: string;
  project: string | null;
  assignee: string | null;
  creator: string | null;
}

export type StartWrite =
  | { kind: 'createTicket'; number: number }
  | { kind: 'recordIdentifier'; number: number; identifier: string }
  | { kind: 'updateBody'; number: number; identifier: string };

export interface StartPlan {
  writes: StartWrite[];
  problems: string[];
}

interface StartFacts {
  slice: string;
  agentTeam: string;
  tickets: readonly TicketFact[];
  children: readonly ChildFact[];
}

// An agent ticket belongs to the agent team and has no project.
const fitsAgentRoute = (child: ChildFact, agentTeam: string) =>
  child.team.toUpperCase() === agentTeam.toUpperCase() && child.project === null;

const describeRoute = (child: ChildFact) => {
  const project = child.project === null ? 'no project' : `project ${child.project}`;

  return `team ${child.team} and ${project}`;
};

const bodyWrites = (number: number, child: ChildFact, body: string): StartWrite[] =>
  sameDescription(child.description, body)
    ? []
    : [{ kind: 'updateBody', number, identifier: child.identifier }];

const planRecorded = (
  facts: StartFacts,
  ticket: TicketFact,
  identifier: string,
  number: number,
): StartPlan => {
  const child = facts.children.find((candidate) => candidate.identifier === identifier);

  if (child === undefined) {
    return {
      writes: [],
      problems: [`Ticket ${number} records ${identifier}, which is not a child of ${facts.slice}.`],
    };
  }

  if (!fitsAgentRoute(child, facts.agentTeam)) {
    return {
      writes: [],
      problems: [
        `Ticket ${number} records ${identifier}, which is in ${describeRoute(child)}, not in team ${facts.agentTeam} with no project. Move it back or record another ticket.`,
      ],
    };
  }

  return { writes: bodyWrites(number, child, ticket.body), problems: [] };
};

const planUnrecorded = (facts: StartFacts, ticket: TicketFact, number: number): StartPlan => {
  const recorded = new Set(facts.tickets.map((other) => other.identifier));

  const sameTitle = facts.children.filter(
    (child) => child.title === ticket.title && !recorded.has(child.identifier),
  );

  const fitting = sameTitle.filter((child) => fitsAgentRoute(child, facts.agentTeam));
  const [match] = fitting;

  if (sameTitle.length === 0) {
    return { writes: [{ kind: 'createTicket', number }], problems: [] };
  }

  if (fitting.length > 1) {
    const names = fitting.map((child) => child.identifier).join(', ');

    return {
      writes: [],
      problems: [
        `Ticket ${number} has no identifier, but ${names} under ${facts.slice} all have its title and fit. Record the right one in start.json or rename the others.`,
      ],
    };
  }

  if (match === undefined) {
    const misfits = sameTitle
      .map((child) => `${child.identifier} (${describeRoute(child)})`)
      .join(', ');

    return {
      writes: [],
      problems: [
        `Ticket ${number} has no identifier, but ${misfits} under ${facts.slice} has its title and is not in team ${facts.agentTeam} with no project. Move or rename it.`,
      ],
    };
  }

  return {
    writes: [
      { kind: 'recordIdentifier', number, identifier: match.identifier },
      ...bodyWrites(number, match, ticket.body),
    ],
    problems: [],
  };
};

// Plans the writes that start a slice's agent tickets, in work order. Any problem stops apply.
export const decideStartPlan = (facts: StartFacts): StartPlan => {
  const writes: StartWrite[] = [];
  const problems: string[] = [];

  for (const [index, ticket] of facts.tickets.entries()) {
    const number = index + 1;

    const plan =
      ticket.identifier === null
        ? planUnrecorded(facts, ticket, number)
        : planRecorded(facts, ticket, ticket.identifier, number);

    writes.push(...plan.writes);
    problems.push(...plan.problems);
  }

  return { writes, problems };
};

export const decideForeignUpdates = (
  viewer: string,
  writes: readonly StartWrite[],
  children: readonly ChildFact[],
): string[] =>
  writes.flatMap((write) => {
    if (write.kind !== 'updateBody') {
      return [];
    }

    const child = children.find((candidate) => candidate.identifier === write.identifier);

    return child === undefined || isViewersTicket(viewer, child) ? [] : [write.identifier];
  });
