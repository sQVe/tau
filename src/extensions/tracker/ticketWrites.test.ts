import { expect, it } from 'vitest';

import { planTicketWrites } from './ticketWrites.js';
import type { TicketWriteFacts } from './ticketWrites.js';

const draft = { title: 'New title', description: '- Details\n' };
const route = { team: 'ME', project: 'Tau' };

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
    facts: { current: draft, request: { directory: 'draft', parent: 'ME-12' } },
    kind: null,
    problems: 1,
  },
  {
    name: 'labels on an update',
    facts: { current: draft, request: { directory: 'draft', labels: [] } },
    kind: null,
    problems: 1,
  },
  { name: 'create', facts: {}, kind: 'createTicket', problems: 0, ...draft },
  {
    name: 'title update',
    facts: { current: { ...draft, title: 'Old' } },
    kind: 'updateTicket',
    problems: 0,
    title: draft.title,
  },
  {
    name: 'description update',
    facts: { current: { ...draft, description: 'Old' } },
    kind: 'updateTicket',
    problems: 0,
    description: draft.description,
  },
  {
    name: 'both fields update',
    facts: { current: { title: 'Old', description: 'Old' } },
    kind: 'updateTicket',
    problems: 0,
    ...draft,
  },
  { name: 'no change', facts: { current: draft }, kind: null, problems: 0 },
  {
    name: 'normalized list marker',
    facts: { current: { ...draft, description: '* Details\n' } },
    kind: null,
    problems: 0,
  },
];

it.each(cases)('plans $name', ({ facts, kind, problems, title, description }) => {
  const plan = planTicketWrites({
    draft,
    route,
    routeProblem: 'Tracker setup needed: test route.',
    request: { directory: 'draft' },
    current: null,
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
