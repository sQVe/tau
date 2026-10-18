import { tmpdir } from 'node:os';

import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import { createLinearFake } from '../../../tests/linearFake.js';
import type { LinearFake } from '../../../tests/linearFake.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { withoutField } from '../../../tests/withoutField.js';
import { createTrackerEvidenceTool } from './tool.js';
import type { TrackerEvidenceInput } from './tool.js';

type FakeCall = LinearFake['calls'][number];

const rateLimit =
  '{"errors":[{"message":"Rate limit exceeded","extensions":{"code":"RATELIMITED"}}]}';

const planned: TrackerEvidenceInput = {
  team: 'ME',
  project: 'Tau',
  parent: null,
  agentTicket: false,
  keywords: 'evidence',
};

const bugLabel = { id: 'label-bug', name: 'Bug' };

const isQuery = ({ command, commandArguments }: FakeCall) => {
  const query = commandArguments[1] ?? '';

  return command === 'linear' && commandArguments[0] === 'api' && query.startsWith('query(');
};

const gather = async (fake: LinearFake, input: Partial<TrackerEvidenceInput> = {}) => {
  const tool = createTrackerEvidenceTool(fake.exec);

  const outcome = await tool
    .execute('call', { ...planned, ...input }, undefined, undefined, noUiContext(tmpdir()))
    .then(
      (result) => ({ evidence: result.details }),
      (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  // Every call must be a `linear api` query, never a mutation or a subcommand that writes.
  expect(fake.calls.filter((call) => !isQuery(call))).toEqual([]);

  if ('error' in outcome) {
    throw new Error(outcome.error);
  }

  return outcome.evidence;
};

type Evidence = Awaited<ReturnType<typeof gather>>;

const expectOneGap = (evidence: Evidence, command: string, error: string) => {
  const [gap, ...others] = evidence.gaps;

  expect(others).toEqual([]);
  expect(gap?.command).toContain(command);
  expect(gap?.error).toContain(error);
};

it('reports a rate-limited search as a gap with no candidate list', async () => {
  const fake = createLinearFake();

  fake.failCall('searchIssues', rateLimit);

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('candidates');
  expectOneGap(evidence, 'searchIssues', 'Rate limit exceeded');
});

it('reports a failed search as a gap with no candidate list', async () => {
  const fake = createLinearFake();

  fake.failCall('searchIssues', 'network error');

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('candidates');
  expect(evidence.labels).toEqual([bugLabel]);
  expectOneGap(evidence, 'searchIssues', 'network error');
});

it('reports malformed search output as a gap with no candidate list', async () => {
  const fake = createLinearFake();

  fake.overrideOutput('searchIssues', '{"data":{"searchIssues":{"nodes":"none"}}}');

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('candidates');
  expectOneGap(evidence, 'searchIssues', 'unexpected output');
});

it('reports an empty search that also carries a GraphQL error as a gap', async () => {
  const fake = createLinearFake();

  fake.overrideOutput(
    'searchIssues',
    JSON.stringify({
      data: { searchIssues: { nodes: [] } },
      errors: [{ message: 'Rate limit exceeded' }],
    }),
  );

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('candidates');
  expectOneGap(evidence, 'searchIssues', 'Rate limit exceeded');
});

it('reports a candidate whose project failed to load as a gap', async () => {
  const fake = createLinearFake();

  const node = {
    identifier: 'ME-4',
    title: 'Gather evidence',
    url: 'https://linear.app/me/issue/ME-4',
    state: { type: 'started' },
    team: { key: 'ME' },
    project: null,
    parent: null,
  };

  fake.overrideOutput(
    'searchIssues',
    JSON.stringify({
      data: { searchIssues: { nodes: [node] } },
      errors: [
        {
          message: 'Could not load project',
          path: ['searchIssues', 'nodes', 0, 'project'],
        },
      ],
    }),
  );

  const evidence = await gather(fake, { project: null });

  expect(evidence).not.toHaveProperty('candidates');
  expectOneGap(evidence, 'searchIssues', 'Could not load project');
});

it('returns an empty candidate list and no gap when nothing matches', async () => {
  const fake = createLinearFake();

  fake.addIssue({ title: 'Rename the statusbar' });

  const evidence = await gather(fake);

  expect(evidence).toEqual({
    candidates: [],
    parent: null,
    labels: [bugLabel],
    gaps: [],
  });
});

it('leaves canceled and duplicate matches out of the candidates', async () => {
  const fake = createLinearFake();

  fake.addIssue({
    identifier: 'ME-4',
    title: 'Gather evidence',
    stateType: 'canceled',
  });

  fake.addIssue({
    identifier: 'ME-5',
    title: 'Gather evidence',
    stateType: 'duplicate',
  });

  const evidence = await gather(fake);

  expect(evidence.candidates).toEqual([]);
  expect(evidence.gaps).toEqual([]);
});

it('lists a match in another project as not fitting, with project as the difference', async () => {
  const fake = createLinearFake();

  fake.addProject({ id: 'project-other', name: 'Other', teamId: 'team-me' });

  fake.addIssue({
    identifier: 'ME-4',
    title: 'Gather evidence',
    projectId: 'project-other',
  });

  const evidence = await gather(fake, { project: null });

  expect(evidence.candidates).toEqual([
    {
      identifier: 'ME-4',
      title: 'Gather evidence',
      url: 'https://linear.app/me/issue/ME-4',
      team: 'ME',
      project: 'Other',
      parent: null,
      fits: false,
      differences: ['project'],
    },
  ]);

  expect(evidence.gaps).toEqual([]);
});

it('fits an agent ticket match under the same parent and does not check the parent route', async () => {
  const fake = createLinearFake();

  fake.addIssue({ identifier: 'ME-1', title: 'Slice' });

  fake.addIssue({
    identifier: 'AI-2',
    title: 'Gather evidence',
    teamId: 'team-ai',
    projectId: null,
    parent: 'ME-1',
  });

  const evidence = await gather(fake, {
    team: 'AI',
    project: null,
    parent: 'ME-1',
    agentTicket: true,
  });

  expect(evidence.candidates).toMatchObject([{ identifier: 'AI-2', fits: true, differences: [] }]);

  expect(evidence.parent).toEqual({
    identifier: 'ME-1',
    team: 'ME',
    project: 'Tau',
    state: 'In Progress',
    matchesRoute: null,
  });

  expect(evidence.labels).toEqual([]);
  expect(evidence.gaps).toEqual([]);
});

it('reports whether the parent matches the route', async () => {
  const fake = createLinearFake();

  fake.addIssue({ identifier: 'ME-1', title: 'Container' });

  const evidence = await gather(fake, { parent: 'ME-1' });

  expect(evidence.parent).toMatchObject({
    identifier: 'ME-1',
    matchesRoute: true,
  });
});

it('reports a missing parent as a gap and leaves the parent unknown', async () => {
  const fake = createLinearFake();

  const evidence = await gather(fake, { parent: 'ME-99' });

  expect(evidence).not.toHaveProperty('parent');
  expectOneGap(evidence, 'ME-99', 'ME-99');
});

it('reports a failed label read as a gap and leaves the labels unknown', async () => {
  const fake = createLinearFake();

  fake.addIssue({ identifier: 'ME-4', title: 'Gather evidence' });
  fake.failCall('labels(', 'network error');

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('labels');
  expect(evidence.candidates).toMatchObject([{ identifier: 'ME-4', fits: true }]);
  expectOneGap(evidence, 'labels', 'network error');
});

it('leaves matches in other teams out of the candidates', async () => {
  const fake = createLinearFake();

  fake.addIssue({ identifier: 'ME-4', title: 'Gather evidence' });

  fake.addIssue({
    identifier: 'AI-5',
    title: 'Gather evidence',
    teamId: 'team-ai',
    projectId: null,
  });

  const evidence = await gather(fake, { project: null });

  expect(evidence.candidates).toMatchObject([{ identifier: 'ME-4' }]);
  expect(evidence.gaps).toEqual([]);
});

it('reports an unknown team as a gap with no candidate list', async () => {
  const fake = createLinearFake();

  fake.addIssue({ identifier: 'ME-4', title: 'Gather evidence' });

  const evidence = await gather(fake, { team: 'XX', project: null });

  expect(evidence).not.toHaveProperty('candidates');

  expect(evidence.gaps).toContainEqual({
    command: 'linear api searchIssues',
    error: 'Linear has no team XX.',
  });
});

it.each([
  { case: 'an empty team', input: { team: ' ' }, error: 'needs a team key' },
  { case: 'empty keywords', input: { keywords: '' }, error: 'needs keywords' },
  {
    case: 'an agent ticket with a project',
    input: { team: 'AI', agentTicket: true },
    error: 'An agent ticket has no project',
  },
  {
    case: 'an agent ticket without a parent',
    input: { team: 'AI', project: null, agentTicket: true },
    error: 'An agent ticket is a sub-ticket of a slice',
  },
])('refuses $case before it reads Linear', async ({ input, error }) => {
  const fake = createLinearFake();

  await expect(gather(fake, input)).rejects.toThrow(error);
  expect(fake.calls).toEqual([]);
});

it('searches only the planned project when one is given', async () => {
  const fake = createLinearFake();

  fake.addProject({ id: 'project-other', name: 'Other', teamId: 'team-me' });
  fake.addIssue({ identifier: 'ME-4', title: 'Gather evidence' });

  fake.addIssue({
    identifier: 'ME-5',
    title: 'Gather evidence',
    projectId: 'project-other',
  });

  const evidence = await gather(fake, { project: 'Tau' });

  expect(evidence.candidates).toMatchObject([{ identifier: 'ME-4', fits: true }]);
});

it('reads a parent with no project as a parent that does not match the route', async () => {
  const fake = createLinearFake();

  fake.addIssue({ identifier: 'ME-1', title: 'Container', projectId: null });

  const evidence = await gather(fake, { parent: 'ME-1' });

  expect(evidence.parent).toEqual({
    identifier: 'ME-1',
    team: 'ME',
    project: null,
    state: 'In Progress',
    matchesRoute: false,
  });

  expect(evidence.gaps).toEqual([]);
});

it('keeps the labels it read and reports a gap when Linear has more pages', async () => {
  const fake = createLinearFake();

  fake.overrideOutput(
    'labels(',
    JSON.stringify({
      data: {
        team: {
          labels: { nodes: [bugLabel], pageInfo: { hasNextPage: true } },
        },
      },
    }),
  );

  const evidence = await gather(fake);

  expect(evidence.labels).toEqual([bugLabel]);
  expectOneGap(evidence, 'labels', 'more labels than one page');
});

it('returns the evidence as JSON text beside the details', async () => {
  const fake = createLinearFake();
  const tool = createTrackerEvidenceTool(fake.exec);

  const result = await tool.execute('call', planned, undefined, undefined, noUiContext(tmpdir()));

  const [content] = result.content;
  const text = content?.type === 'text' ? content.text : '';

  expect(content?.type).toBe('text');
  expect(JSON.parse(text)).toEqual(result.details);
});

it('refuses keywords that hold only whitespace before it reads Linear', async () => {
  const fake = createLinearFake();

  await expect(gather(fake, { keywords: '   ' })).rejects.toThrow('needs keywords');
  expect(fake.calls).toEqual([]);
});

const searchNode = {
  identifier: 'ME-4',
  title: 'Gather evidence',
  url: 'https://linear.app/me/issue/ME-4',
  state: { type: 'started' },
  team: { key: 'ME' },
  project: null,
  parent: null,
};

const parentIssue = {
  team: { key: 'ME' },
  project: { name: 'Tau' },
  state: { name: 'Todo' },
};

const labelNode = { id: 'label-bug', name: 'Bug' };

it.each(Object.keys(searchNode))(
  'reports a search match without %s as malformed output',
  async (field) => {
    const fake = createLinearFake();

    fake.overrideOutput(
      'searchIssues',
      JSON.stringify({
        data: { searchIssues: { nodes: [withoutField(searchNode, field)] } },
      }),
    );

    const evidence = await gather(fake);

    expect(evidence).not.toHaveProperty('candidates');
    expectOneGap(evidence, 'searchIssues', 'unexpected output');
  },
);

it.each(Object.keys(parentIssue))(
  'reports a parent without %s as malformed output',
  async (field) => {
    const fake = createLinearFake();

    fake.overrideOutput(
      'issue(',
      JSON.stringify({ data: { issue: withoutField(parentIssue, field) } }),
    );

    const evidence = await gather(fake, { parent: 'ME-1' });

    expect(evidence).not.toHaveProperty('parent');
    expectOneGap(evidence, 'ME-1', 'unexpected output');
  },
);

it.each([
  {
    case: 'a label without an id',
    labels: { nodes: [{ name: 'Bug' }], pageInfo: { hasNextPage: false } },
  },
  {
    case: 'a label without a name',
    labels: { nodes: [{ id: 'x' }], pageInfo: { hasNextPage: false } },
  },
  { case: 'labels without page info', labels: { nodes: [labelNode] } },
  {
    case: 'page info without a flag',
    labels: { nodes: [labelNode], pageInfo: {} },
  },
  {
    case: 'labels without nodes',
    labels: { pageInfo: { hasNextPage: false } },
  },
])('reports $case as malformed output', async ({ labels }) => {
  const fake = createLinearFake();

  fake.overrideOutput('labels(', JSON.stringify({ data: { team: { labels } } }));

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('labels');
  expectOneGap(evidence, 'labels', 'unexpected output');
});

it.each([{ data: {} }, { data: { team: { id: 7 } } }, { data: { team: {} } }])(
  'reports a malformed team reply as a gap with no candidate list',
  async (reply) => {
    const fake = createLinearFake();

    fake.overrideOutput('{ id } }', JSON.stringify(reply));

    const evidence = await gather(fake);

    expect(evidence).not.toHaveProperty('candidates');
    expectOneGap(evidence, 'searchIssues', 'unexpected output');
  },
);

it('reports a malformed parent reply without an issue field as a gap', async () => {
  const fake = createLinearFake();

  fake.overrideOutput('issue(', JSON.stringify({ data: {} }));

  const evidence = await gather(fake, { parent: 'ME-1' });

  expect(evidence).not.toHaveProperty('parent');
  expectOneGap(evidence, 'ME-1', 'unexpected output');
});

it('reports a label reply without a team field as a gap', async () => {
  const fake = createLinearFake();

  fake.overrideOutput('labels(', JSON.stringify({ data: {} }));

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('labels');
  expectOneGap(evidence, 'labels', 'unexpected output');
});

it('reports a search reply without nodes as malformed output', async () => {
  const fake = createLinearFake();

  fake.overrideOutput('searchIssues', JSON.stringify({ data: { searchIssues: {} } }));

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('candidates');
  expectOneGap(evidence, 'searchIssues', 'unexpected output');
});

it.each([
  { name: 'a planned ticket with a project', input: planned },
  {
    name: 'a planned ticket with no project and a parent',
    input: { ...planned, project: null, parent: 'ME-1' },
  },
])('accepts $name as tool input', ({ input }) => {
  expect(Value.Check(createTrackerEvidenceTool(createLinearFake().exec).parameters, input)).toBe(
    true,
  );
});

it.each([
  { name: 'a project that is a number', input: { ...planned, project: 3 } },
  { name: 'a parent that is a number', input: { ...planned, parent: 3 } },
  { name: 'no project', input: { team: 'ME', parent: null, agentTicket: false, keywords: 'x' } },
  { name: 'no keywords', input: { team: 'ME', project: null, parent: null, agentTicket: false } },
])('refuses $name as tool input', ({ input }) => {
  expect(Value.Check(createTrackerEvidenceTool(createLinearFake().exec).parameters, input)).toBe(
    false,
  );
});

it.each([
  { name: 'a state type that is not text', node: { ...searchNode, state: { type: 1 } } },
  { name: 'a team key that is not text', node: { ...searchNode, team: { key: 1 } } },
  { name: 'a project name that is not text', node: { ...searchNode, project: { name: 1 } } },
  {
    name: 'a parent identifier that is not text',
    node: { ...searchNode, parent: { identifier: 1 } },
  },
])('reports a search match with $name as malformed output', async ({ node }) => {
  const fake = createLinearFake();

  fake.overrideOutput(
    'searchIssues',
    JSON.stringify({ data: { searchIssues: { nodes: [node] } } }),
  );

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('candidates');
  expectOneGap(evidence, 'searchIssues', 'unexpected output');
});

it.each([
  { name: 'a team key that is not text', issue: { ...parentIssue, team: { key: 1 } } },
  { name: 'a project name that is not text', issue: { ...parentIssue, project: { name: 1 } } },
  { name: 'a state name that is not text', issue: { ...parentIssue, state: { name: 1 } } },
])('reports a parent with $name as malformed output', async ({ issue }) => {
  const fake = createLinearFake();

  fake.overrideOutput('issue(', JSON.stringify({ data: { issue } }));

  const evidence = await gather(fake, { parent: 'ME-1' });

  expect(evidence).not.toHaveProperty('parent');
  expectOneGap(evidence, 'ME-1', 'unexpected output');
});

it('reports a label read for a team Linear does not know as a gap', async () => {
  const fake = createLinearFake();

  fake.overrideOutput('labels(', JSON.stringify({ data: { team: null } }));

  const evidence = await gather(fake);

  expect(evidence).not.toHaveProperty('labels');
  expectOneGap(evidence, 'labels', 'Linear has no team ME');
});
