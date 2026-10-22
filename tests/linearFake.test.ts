import { expect, test } from 'vitest';

import { createLinearFake } from './linearFake.js';

const teamQuery = 'query($key: String!) { team(id: $key) { id } }';

const updateMutation =
  'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }';

const createMutation =
  'mutation($team: String!, $title: String!, $description: String!, $labels: [String!]) { issueCreate(input: { teamId: $team, title: $title, description: $description, labelIds: $labels }) { issue { identifier url } } }';

const createWithoutTitle =
  'mutation($team: String!, $title: String!, $description: String!) { issueCreate(input: { teamId: $team, title: $title, description: $description }) { issue { identifier url } } }';

const refusedCalls: [string, string, string[]][] = [
  ['another executable', 'not-linear', ['api', 'query { team(id: "ME") { id } }']],
  ['an unknown query', 'linear', ['api', 'query { definitelyNotALinearField }']],
  ['an unknown gh command', 'gh', ['not-a-command']],
  ['a gh pull request read without the state field', 'gh', ['pr', 'view', 'url']],
  ['an issue update command', 'linear', ['issue', 'update', 'ME-1', '--title', 'New']],
  ['an unknown issue command', 'linear', ['issue', 'view', 'ME-1']],
  ['a query without its variable', 'linear', ['api', teamQuery]],
  [
    'a query that does not declare the variable it reads',
    'linear',
    ['api', 'query { team(id: "ME") { id } }', '--variable', 'key=ME'],
  ],
  ['a variable of the wrong type', 'linear', ['api', teamQuery, '--variable', 'key=123']],
  [
    'an unknown linear api flag',
    'linear',
    ['api', teamQuery, '--variable', 'key=ME', '--verbose', 'yes'],
  ],
];

test.each(refusedCalls)(
  'refuses %s with code 1 and records no write',
  async (_name, command, args) => {
    const fake = createLinearFake();

    const result = await fake.exec(command, args);

    expect(result.code).toBe(1);
    expect(fake.writes()).toEqual([]);
  },
);

test('refuses an update without its input and leaves the issue unchanged', async () => {
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Keep', description: 'Body', sortOrder: 3 });

  const result = await fake.exec('linear', ['api', updateMutation, '--variable', 'id=ME-1']);

  expect(result.code).toBe(1);
  expect(fake.writes()).toEqual([]);
  expect(issue.title).toBe('Keep');
  expect(issue.description).toBe('Body');
  expect(issue.sortOrder).toBe(3);
});

test('refuses a malformed relation command and leaves the issues unchanged', async () => {
  const fake = createLinearFake();
  const blocked = fake.addIssue({ title: 'Blocked' });
  const blocker = fake.addIssue({ title: 'Blocker' });

  const result = await fake.exec('linear', ['issue', 'relation', 'add', 'ME-1', 'blocks', 'ME-2']);

  expect(result.code).toBe(1);
  expect(blocked.blockedBy).toEqual([]);
  expect(blocker.blockedBy).toEqual([]);
  expect(fake.writes()).toEqual([]);
});

test('refuses an optional variable of the wrong type and creates no issue', async () => {
  const fake = createLinearFake();

  const variables = { team: 'team-me', title: 'T', description: 'D', labels: [1] };

  const result = await fake.exec('linear', [
    'api',
    createMutation,
    '--variables-json',
    JSON.stringify(variables),
  ]);

  expect(result.code).toBe(1);
  expect(fake.issues.size).toBe(0);
  expect(fake.writes()).toEqual([]);
});

test('an override or failure does not rescue an unsupported call', async () => {
  const fake = createLinearFake();

  fake.overrideOutput('not-a-command', '{}');
  fake.overrideOutput('definitelyNotALinearField', '{}');

  const gh = await fake.exec('gh', ['not-a-command']);
  const query = await fake.exec('linear', ['api', 'query { definitelyNotALinearField }']);

  expect(gh.code).toBe(1);
  expect(gh.stdout).toBe('');
  expect(query.code).toBe(1);
  expect(query.stdout).toBe('');
});

test('failWrite counts only supported writes', async () => {
  const fake = createLinearFake();

  fake.failWrite(1);

  const refused = await fake.exec('linear', [
    'api',
    createWithoutTitle,
    '--variable',
    'team=team-me',
    '--variable',
    'description=Body',
  ]);

  expect(refused.code).toBe(1);
  expect(fake.writes()).toEqual([]);

  const created = await fake.exec('linear', [
    'api',
    createWithoutTitle,
    '--variable',
    'team=team-me',
    '--variable',
    'title=Ticket',
    '--variable',
    'description=Body',
  ]);

  expect(created.code).toBe(1);
  expect(created.stderr).toBe('network error');
  expect(fake.writes()).toHaveLength(1);
});

test('answers a team read', async () => {
  const fake = createLinearFake();

  const result = await fake.exec('linear', ['api', teamQuery, '--variable', 'key=ME']);

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ data: { team: { id: 'team-me' } } });
});
