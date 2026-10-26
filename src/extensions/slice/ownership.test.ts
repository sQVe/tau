import { describe, expect, it } from 'vitest';

import { isViewersTicket } from './ownership.js';

describe('isViewersTicket', () => {
  it.each([
    {
      case: 'the viewer is the assignee',
      ticket: { assignee: 'viewer', creator: 'other' },
      owned: true,
    },
    {
      case: 'the viewer is the assignee and the creator is unknown',
      ticket: { assignee: 'viewer', creator: null },
      owned: true,
    },
    {
      case: 'no assignee and the viewer created it',
      ticket: { assignee: null, creator: 'viewer' },
      owned: true,
    },
    {
      case: 'another person is the assignee',
      ticket: { assignee: 'other', creator: 'viewer' },
      owned: false,
    },
    {
      case: 'no assignee and another person created it',
      ticket: { assignee: null, creator: 'other' },
      owned: false,
    },
    {
      case: 'no assignee and the creator is unknown',
      ticket: { assignee: null, creator: null },
      owned: false,
    },
  ])('returns $owned when $case', ({ ticket, owned }) => {
    expect(isViewersTicket('viewer', ticket)).toBe(owned);
  });
});
