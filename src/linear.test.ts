import { expect, test } from 'vitest';

import { createLinearFake } from '../tests/linearFake.js';
import { readTeamId } from './linear.js';

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
