import { expect, it } from 'vitest';

import { planTicketWrites, resolveTicketBinding } from './ticketWrites.js';
import type { TicketWriteFacts } from './ticketWrites.js';

const draft = { title: 'New title', description: '- Details\n' };
const route = { team: 'ME', project: 'Tau' };

const ticket = {
  ...draft,
  id: 'ticket-id',
  identifier: 'ME-1',
  url: 'https://linear.app/me/issue/ME-1',
  viewer: 'viewer',
  creator: 'viewer',
  assignee: null,
};

const cases: {
  name: string;
  facts: Partial<TicketWriteFacts>;
  kind: string | null;
  problems: number;
  title?: string;
  description?: string;
}[] = [
  { name: 'empty title', facts: { draft: { ...draft, title: '' } }, kind: null, problems: 1 },
  {
    name: 'multiline title',
    facts: { draft: { ...draft, title: 'First\nSecond' } },
    kind: null,
    problems: 1,
  },
  {
    name: 'invalid parent',
    facts: { request: { directory: 'draft', parent: 'id-ME-12' } },
    kind: null,
    problems: 1,
  },
  { name: 'no route', facts: { route: undefined }, kind: null, problems: 1 },
  {
    name: 'parent on an update',
    facts: { current: ticket, request: { directory: 'draft', parent: 'ME-12' } },
    kind: null,
    problems: 1,
  },
  {
    name: 'labels on an update',
    facts: { current: ticket, request: { directory: 'draft', labels: [] } },
    kind: null,
    problems: 1,
  },
  { name: 'create', facts: {}, kind: 'createTicket', problems: 0, ...draft },
  {
    name: 'binding conflict',
    facts: { bindingProblem: 'The draft records ME-1, not ME-2.' },
    kind: null,
    problems: 1,
  },
  {
    name: 'explicit ticket update',
    facts: {
      current: { ...ticket, title: 'Old' },
      request: { directory: 'draft', ticket: ticket.identifier },
    },
    kind: 'updateTicket',
    problems: 0,
    title: draft.title,
  },
  {
    name: 'explicit ticket with parent',
    facts: {
      current: ticket,
      request: { directory: 'draft', ticket: ticket.identifier, parent: 'ME-2' },
    },
    kind: null,
    problems: 1,
  },
  {
    name: 'explicit ticket with labels',
    facts: {
      current: ticket,
      request: { directory: 'draft', ticket: ticket.identifier, labels: [] },
    },
    kind: null,
    problems: 1,
  },
  {
    name: 'unrecorded title match created by the viewer',
    facts: {
      candidates: [
        { identifier: 'ME-12', title: draft.title, creator: 'viewer', viewer: 'viewer' },
      ],
    },
    kind: null,
    problems: 1,
  },
  {
    name: 'title match created by another person',
    facts: {
      candidates: [{ identifier: 'ME-12', title: draft.title, creator: 'other', viewer: 'viewer' }],
    },
    kind: 'createTicket',
    problems: 0,
    ...draft,
  },
  {
    name: 'title match with no creator',
    facts: {
      candidates: [{ identifier: 'ME-12', title: draft.title, creator: null, viewer: 'viewer' }],
    },
    kind: 'createTicket',
    problems: 0,
    ...draft,
  },
  {
    name: 'different title created by the viewer',
    facts: {
      candidates: [
        { identifier: 'ME-12', title: 'Other title', creator: 'viewer', viewer: 'viewer' },
      ],
    },
    kind: 'createTicket',
    problems: 0,
    ...draft,
  },
  {
    name: 'recorded ticket with a title match',
    facts: {
      current: ticket,
      candidates: [
        { identifier: 'ME-12', title: draft.title, creator: 'viewer', viewer: 'viewer' },
      ],
    },
    kind: null,
    problems: 0,
  },
  {
    name: 'title update',
    facts: { current: { ...ticket, title: 'Old' } },
    kind: 'updateTicket',
    problems: 0,
    title: draft.title,
  },
  {
    name: 'description update',
    facts: { current: { ...ticket, description: 'Old' } },
    kind: 'updateTicket',
    problems: 0,
    description: draft.description,
  },
  {
    name: 'both fields update',
    facts: { current: { ...ticket, title: 'Old', description: 'Old' } },
    kind: 'updateTicket',
    problems: 0,
    ...draft,
  },
  { name: 'no change', facts: { current: ticket }, kind: null, problems: 0 },
  {
    name: 'normalized list marker',
    facts: { current: { ...ticket, description: '* Details\n' } },
    kind: null,
    problems: 0,
  },
];

it.each([
  { name: 'new draft', recorded: null, requested: undefined, identifier: null, conflict: false },
  {
    name: 'first update',
    recorded: null,
    requested: 'ME-42',
    identifier: 'ME-42',
    conflict: false,
  },
  {
    name: 'recorded ticket',
    recorded: 'ME-42',
    requested: undefined,
    identifier: 'ME-42',
    conflict: false,
  },
  {
    name: 'same ticket',
    recorded: 'ME-42',
    requested: 'ME-42',
    identifier: 'ME-42',
    conflict: false,
  },
  {
    name: 'different ticket',
    recorded: 'ME-42',
    requested: 'ME-43',
    identifier: 'ME-42',
    conflict: true,
  },
])('resolves binding for $name', ({ recorded, requested, identifier, conflict }) => {
  const binding = resolveTicketBinding(recorded, requested);

  expect(binding.identifier).toBe(identifier);
  expect(binding.problem !== undefined).toBe(conflict);
});

it.each(cases)('plans $name', ({ facts, kind, problems, title, description }) => {
  const plan = planTicketWrites({
    draft,
    route,
    routeProblem: 'Tracker setup needed: test route.',
    request: { directory: 'draft' },
    current: null,
    bindingProblem: undefined,
    candidates: [],
    ...facts,
  });

  expect(plan.problems).toHaveLength(problems);

  const writes = plan.writes.map(
    ({ kind: writeKind, title: writeTitle, description: writeDescription }) => ({
      kind: writeKind,
      title: writeTitle,
      description: writeDescription,
    }),
  );

  const expected = kind === null ? [] : [{ kind, title, description }];

  expect(writes).toEqual(expected);
});
