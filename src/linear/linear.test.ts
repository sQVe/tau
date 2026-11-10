import { expect, test } from 'vitest';

import { createLinearFake } from '../../tests/linearFake.js';
import { readRouteIds, readTeamId } from './linear.js';

test.each([
  { route: { team: 'ME', project: 'Tau' }, expected: { team: 'team-me', project: 'project-tau' } },
  { route: { team: 'AI', project: null }, expected: { team: 'team-ai', project: null } },
])('resolves route IDs for $route', async ({ route, expected }) => {
  const fake = createLinearFake();

  await expect(readRouteIds(fake.exec, '/repo', route)).resolves.toEqual(expected);
  expect(fake.writes()).toEqual([]);
});

test.each(['missing team', 'missing project', 'ambiguous project', 'malformed response'])(
  'refuses route IDs for %s without writes',
  async (problem) => {
    const fake = createLinearFake();
    const route = { team: 'ME', project: 'Tau' };

    if (problem === 'missing team') {
      route.team = 'UNKNOWN';
    }

    if (problem === 'missing project') {
      route.project = 'Missing';
    }

    if (problem === 'ambiguous project') {
      fake.addProject({ id: 'second', name: 'Tau', teamId: 'team-me' });
    }

    if (problem === 'malformed response') {
      fake.overrideOutput('projects(', '{"data":{"team":{"id":"team-me","projects":null}}}');
    }

    await expect(readRouteIds(fake.exec, '/repo', route)).rejects.toThrow(
      /no team|exactly one project|unexpected output/u,
    );

    expect(fake.writes()).toEqual([]);
  },
);

test('readTeamId returns the id of a known team', async () => {
  const fake = createLinearFake();

  await expect(readTeamId(fake.exec, '/repo', 'ME')).resolves.toBe('team-me');
});

test('readTeamId rejects when Linear has no such team', async () => {
  const fake = createLinearFake();

  await expect(readTeamId(fake.exec, '/repo', 'NOPE')).rejects.toThrow('Linear has no team NOPE.');
});

test('readTeamId rejects a response that does not match the schema', async () => {
  const fake = createLinearFake();
  fake.overrideOutput('team(id', '{"data":{"team":{"id":7}}}');

  await expect(readTeamId(fake.exec, '/repo', 'ME')).rejects.toThrow('printed unexpected output');
});
