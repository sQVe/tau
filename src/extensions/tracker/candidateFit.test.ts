import { expect, it } from 'vitest';

import { decideCandidateFit, decideParentMatchesRoute } from './candidateFit.js';
import type { Placement } from './candidateFit.js';

const slice: Placement = { team: 'ME', project: 'Tau', parent: 'ME-10' };
const agentTicket: Placement = { team: 'AI', project: null, parent: 'ME-10' };

it.each([
  { case: 'same placement', planned: slice, candidate: slice, fits: true, differences: [] },
  {
    case: 'another team',
    planned: slice,
    candidate: { ...slice, team: 'OPS' },
    fits: false,
    differences: ['team'],
  },
  {
    case: 'another project',
    planned: slice,
    candidate: { ...slice, project: 'Other' },
    fits: false,
    differences: ['project'],
  },
  {
    case: 'no project when one is planned',
    planned: slice,
    candidate: { ...slice, project: null },
    fits: false,
    differences: ['project'],
  },
  {
    case: 'another parent',
    planned: slice,
    candidate: { ...slice, parent: 'ME-11' },
    fits: false,
    differences: ['parent'],
  },
  {
    case: 'no parent when one is planned',
    planned: slice,
    candidate: { ...slice, parent: null },
    fits: false,
    differences: ['parent'],
  },
  {
    case: 'agent ticket with no project',
    planned: agentTicket,
    candidate: agentTicket,
    fits: true,
    differences: [],
  },
  {
    case: 'agent ticket and a candidate in a project',
    planned: agentTicket,
    candidate: { ...agentTicket, project: 'Tau' },
    fits: false,
    differences: ['project'],
  },
  {
    case: 'every field differs',
    planned: slice,
    candidate: { team: 'OPS', project: null, parent: null },
    fits: false,
    differences: ['team', 'project', 'parent'],
  },
])('decides fit for $case', ({ planned, candidate, fits, differences }) => {
  expect(decideCandidateFit(planned, candidate)).toEqual({ fits, differences });
});

const route = { team: 'ME', project: 'Tau' };

it.each([
  { case: 'same route', agentTicket: false, route, parent: route, matches: true },
  {
    case: 'another team',
    agentTicket: false,
    route,
    parent: { ...route, team: 'OPS' },
    matches: false,
  },
  {
    case: 'another project',
    agentTicket: false,
    route,
    parent: { ...route, project: 'Other' },
    matches: false,
  },
  {
    case: 'a route with no project and a parent in one',
    agentTicket: false,
    route: { team: 'ME', project: null },
    parent: route,
    matches: false,
  },
  {
    case: 'an agent ticket',
    agentTicket: true,
    route: { team: 'AI', project: null },
    parent: route,
    matches: null,
  },
])('decides whether the parent matches the route for $case', ({ matches, ...facts }) => {
  expect(decideParentMatchesRoute(facts)).toBe(matches);
});
