import { tmpdir } from 'node:os';

import { expect, it } from 'vitest';

import { createLinearFake } from '../../../tests/linearFake.js';
import type { LinearFake } from '../../../tests/linearFake.js';
import { noUiContext } from '../../../tests/toolContext.js';
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
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
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
      data: { searchIssues: { nodes: [], pageInfo: { hasNextPage: false } } },
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
      data: { searchIssues: { nodes: [node], pageInfo: { hasNextPage: false } } },
      errors: [
        { message: 'Could not load project', path: ['searchIssues', 'nodes', 0, 'project'] },
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

  expect(evidence).toEqual({ candidates: [], parent: null, labels: [bugLabel], gaps: [] });
});

it('leaves canceled and duplicate matches out of the candidates', async () => {
  const fake = createLinearFake();

  fake.addIssue({ identifier: 'ME-4', title: 'Gather evidence', stateType: 'canceled' });
  fake.addIssue({ identifier: 'ME-5', title: 'Gather evidence', stateType: 'duplicate' });

  const evidence = await gather(fake);

  expect(evidence.candidates).toEqual([]);
  expect(evidence.gaps).toEqual([]);
});

it('lists a match in another project as not fitting, with project as the difference', async () => {
  const fake = createLinearFake();

  fake.addProject({ id: 'project-other', name: 'Other', teamId: 'team-me' });
  fake.addIssue({ identifier: 'ME-4', title: 'Gather evidence', projectId: 'project-other' });

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

  expect(evidence.parent).toMatchObject({ identifier: 'ME-1', matchesRoute: true });
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

it('keeps the candidates of a search with more pages and reports the list as incomplete', async () => {
  const fake = createLinearFake();

  const node = {
    identifier: 'ME-4',
    title: 'Gather evidence',
    url: 'https://linear.app/me/issue/ME-4',
    state: { type: 'started' },
    team: { key: 'ME' },
    project: { name: 'Tau' },
    parent: null,
  };

  fake.overrideOutput(
    'searchIssues',
    JSON.stringify({ data: { searchIssues: { nodes: [node], pageInfo: { hasNextPage: true } } } }),
  );

  const evidence = await gather(fake);

  expect(evidence.candidates).toMatchObject([{ identifier: 'ME-4', fits: true }]);
  expectOneGap(evidence, 'searchIssues', 'incomplete');
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
