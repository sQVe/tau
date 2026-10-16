import { describe, expect, it } from 'vitest';

import { decideForeignUpdates, decideStartPlan } from './startDecisions.js';
import type { ChildFact, TicketFact } from './startDecisions.js';

const ticket = (overrides: Partial<TicketFact> = {}): TicketFact => ({
  title: 'Record the start',
  identifier: null,
  body: 'Body.\n',
  ...overrides,
});

const child = (overrides: Partial<ChildFact> = {}): ChildFact => ({
  identifier: 'AI-5',
  title: 'Record the start',
  description: 'Body.\n',
  team: 'AI',
  project: null,
  assignee: null,
  creator: 'viewer',
  ...overrides,
});

const plan = (tickets: TicketFact[], children: ChildFact[]) =>
  decideStartPlan({ slice: 'ME-700', agentTeam: 'AI', tickets, children });

describe('decideStartPlan', () => {
  it.each([
    {
      case: 'no identifier and no child',
      tickets: [ticket()],
      children: [],
      writes: [{ kind: 'createTicket', number: 1 }],
      problems: [],
    },
    {
      case: 'a recorded identifier with the same body',
      tickets: [ticket({ identifier: 'AI-5' })],
      children: [child()],
      writes: [],
      problems: [],
    },
    {
      case: 'a recorded identifier whose list markers Linear rewrote',
      tickets: [ticket({ identifier: 'AI-5', body: '- one\n' })],
      children: [child({ description: '* one\n' })],
      writes: [],
      problems: [],
    },
    {
      case: 'a recorded identifier with a changed body',
      tickets: [ticket({ identifier: 'AI-5', body: 'New.\n' })],
      children: [child()],
      writes: [{ kind: 'updateBody', number: 1, identifier: 'AI-5' }],
      problems: [],
    },
    {
      case: 'a recorded identifier that is not a child',
      tickets: [ticket({ identifier: 'AI-9' })],
      children: [child()],
      writes: [],
      problems: ['Ticket 1 records AI-9, which is not a child of ME-700.'],
    },
    {
      case: 'a same-title child that fits, with the same body',
      tickets: [ticket()],
      children: [child()],
      writes: [{ kind: 'recordIdentifier', number: 1, identifier: 'AI-5' }],
      problems: [],
    },
    {
      case: 'a same-title child that fits, with a changed body',
      tickets: [ticket({ body: 'New.\n' })],
      children: [child()],
      writes: [
        { kind: 'recordIdentifier', number: 1, identifier: 'AI-5' },
        { kind: 'updateBody', number: 1, identifier: 'AI-5' },
      ],
      problems: [],
    },
    {
      case: 'a same-title child in another team',
      tickets: [ticket()],
      children: [child({ team: 'ME' })],
      writes: [],
      problems: [
        'Ticket 1 has no identifier, but AI-5 (team ME and no project) under ME-700 has its title and is not in team AI with no project. Move or rename it.',
      ],
    },
    {
      case: 'a same-title child with a project',
      tickets: [ticket()],
      children: [child({ project: 'Tau' })],
      writes: [],
      problems: [
        'Ticket 1 has no identifier, but AI-5 (team AI and project Tau) under ME-700 has its title and is not in team AI with no project. Move or rename it.',
      ],
    },
    {
      case: 'two same-title children that fit',
      tickets: [ticket()],
      children: [child(), child({ identifier: 'AI-6' })],
      writes: [],
      problems: [
        'Ticket 1 has no identifier, but AI-5, AI-6 under ME-700 all have its title and fit. Record the right one in start.json or rename the others.',
      ],
    },
    {
      case: 'a same-title child that another ticket records',
      tickets: [ticket({ title: 'Other', identifier: 'AI-5' }), ticket()],
      children: [child({ title: 'Other' })],
      writes: [{ kind: 'createTicket', number: 2 }],
      problems: [],
    },
    {
      case: 'a retry after a partial failure',
      tickets: [
        ticket({ title: 'First', identifier: 'AI-5' }),
        ticket({ title: 'Second' }),
        ticket({ title: 'Third' }),
      ],
      children: [child({ title: 'First' })],
      writes: [
        { kind: 'createTicket', number: 2 },
        { kind: 'createTicket', number: 3 },
      ],
      problems: [],
    },
  ])('plans $case', ({ tickets, children, writes, problems }) => {
    expect(plan(tickets, children)).toEqual({ writes, problems });
  });

  it('matches the agent team without regard to case', () => {
    const result = decideStartPlan({
      slice: 'ME-700',
      agentTeam: 'ai',
      tickets: [ticket()],
      children: [child()],
    });

    expect(result.writes).toEqual([{ kind: 'recordIdentifier', number: 1, identifier: 'AI-5' }]);
  });
});

describe('decideForeignUpdates', () => {
  const update = [{ kind: 'updateBody', number: 1, identifier: 'AI-5' }] as const;

  it.each([
    {
      case: 'the viewer is the assignee',
      overrides: { assignee: 'viewer', creator: 'other' },
      foreign: [],
    },
    {
      case: 'no assignee and the viewer created it',
      overrides: { assignee: null, creator: 'viewer' },
      foreign: [],
    },
    {
      case: 'another person is the assignee',
      overrides: { assignee: 'other', creator: 'viewer' },
      foreign: ['AI-5'],
    },
    {
      case: 'no assignee and another person created it',
      overrides: { assignee: null, creator: 'other' },
      foreign: ['AI-5'],
    },
    {
      case: 'the owner is unknown',
      overrides: { assignee: null, creator: null },
      foreign: ['AI-5'],
    },
  ])('lists the ticket when $case', ({ overrides, foreign }) => {
    expect(decideForeignUpdates('viewer', update, [child(overrides)])).toEqual(foreign);
  });

  it('ignores writes that do not change a Linear ticket', () => {
    const writes = [{ kind: 'recordIdentifier', number: 1, identifier: 'AI-5' }] as const;

    expect(decideForeignUpdates('viewer', writes, [child({ creator: 'other' })])).toEqual([]);
  });
});
