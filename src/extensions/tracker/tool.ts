import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import type { Exec } from '../../exec.js';
import { decideCandidateFit, decideParentMatchesRoute } from './candidateFit.js';
import type { CandidateFit, Placement } from './candidateFit.js';
import { readLabels, readParentRouting, searchIssues } from './linear.js';
import type { FoundIssue, Label, ParentRouting } from './linear.js';

interface Gap {
  command: string;
  error: string;
}

type Candidate = FoundIssue & CandidateFit;

type ParentEvidence = ParentRouting & { identifier: string; matchesRoute: boolean | null };

interface TrackerEvidence {
  candidates?: Candidate[];
  parent?: ParentEvidence | null;
  labels?: Label[];
  gaps: Gap[];
}

type Attempt<T> = { value: T } | { gap: Gap };

const trackerEvidenceParameters = Type.Object({
  team: Type.String({ description: 'Key of the team the planned ticket goes to.' }),
  project: Type.Union([Type.String(), Type.Null()], {
    description: 'Project name of the planned ticket, or null when it has none.',
  }),
  parent: Type.Union([Type.String(), Type.Null()], {
    description: 'Identifier of the planned parent, or null when the ticket has none.',
  }),
  agentTicket: Type.Boolean({ description: 'True when the planned ticket is an agent ticket.' }),
  keywords: Type.String({ description: 'A few keywords from the planned title to search for.' }),
});

export type TrackerEvidenceInput = Static<typeof trackerEvidenceParameters>;

const description = `Reads, without any Linear write, the evidence the tracker skill needs before it plans a ticket.
Parameters: team (key), project (name or null), parent (identifier or null), agentTicket (an agent ticket has no project, and its parent is not checked against the route), and keywords (search term). An empty team or keywords, or an agent ticket with a project, is an error.
Returns {candidates, parent, labels, gaps}:
- candidates: the open issues that match the keywords in the team, and in the project when one is given. Each has identifier, title, url, team, project, parent, fits, and differences. fits is true when team, project, and parent all equal the planned ticket's; differences lists the ones that do not.
- parent: {identifier, team, project, state, matchesRoute}, or null when parent is null. matchesRoute is whether the parent's team and project equal the given ones, and null for an agent ticket.
- labels: the team's labels as {id, name}.
- gaps: {command, error} for each read that failed, was rate limited, or printed malformed output, and for a list with more pages. A failed read leaves its field out, so a missing field means unknown, never empty. A list with more pages keeps the issues it read, but is incomplete.`;

const searchCommand = 'linear api searchIssues';

const attempt = async <T>(command: string, read: () => Promise<T>): Promise<Attempt<T>> => {
  try {
    return { value: await read() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { gap: { command, error: message } };
  }
};

const morePagesGap = (command: string, list: string): Gap => ({
  command,
  error: `Linear has more ${list} than one page holds, so the ${list} list is incomplete.`,
});

// Rejects inputs that would read the wrong team or compare against the wrong placement.
const checkInput = (input: TrackerEvidenceInput) => {
  if (input.team.trim() === '') {
    throw new Error('tracker_evidence needs a team key.');
  }

  if (input.keywords.trim() === '') {
    throw new Error('tracker_evidence needs keywords to search for.');
  }

  if (input.agentTicket && input.project !== null) {
    throw new Error('An agent ticket has no project, so pass project: null.');
  }
};

const gatherCandidates = async (exec: Exec, cwd: string, input: TrackerEvidenceInput) => {
  const search = await attempt(searchCommand, () => searchIssues(exec, cwd, input));

  if ('gap' in search) {
    return { gaps: [search.gap] };
  }

  const planned: Placement = { team: input.team, project: input.project, parent: input.parent };

  const candidates = search.value.issues.map((issue) => ({
    ...issue,
    ...decideCandidateFit(planned, issue),
  }));

  const gaps = search.value.hasNextPage ? [morePagesGap(searchCommand, 'issues')] : [];

  return { candidates, gaps };
};

const gatherParent = async (exec: Exec, cwd: string, input: TrackerEvidenceInput) => {
  const identifier = input.parent;

  if (identifier === null) {
    return { parent: null, gaps: [] };
  }

  const command = `linear api issue ${identifier}`;
  const read = await attempt(command, () => readParentRouting(exec, cwd, identifier));

  if ('gap' in read) {
    return { gaps: [read.gap] };
  }

  const matchesRoute = decideParentMatchesRoute({
    agentTicket: input.agentTicket,
    route: { team: input.team, project: input.project },
    parent: read.value,
  });

  return { parent: { identifier, ...read.value, matchesRoute }, gaps: [] };
};

const gatherLabels = async (exec: Exec, cwd: string, team: string) => {
  const command = `linear api team ${team} labels`;
  const read = await attempt(command, () => readLabels(exec, cwd, team));

  if ('gap' in read) {
    return { gaps: [read.gap] };
  }

  const gaps = read.value.hasNextPage ? [morePagesGap(command, 'labels')] : [];

  return { labels: read.value.labels, gaps };
};

const gatherEvidence = async (
  exec: Exec,
  cwd: string,
  input: TrackerEvidenceInput,
): Promise<TrackerEvidence> => {
  checkInput(input);

  const [candidates, parent, labels] = await Promise.all([
    gatherCandidates(exec, cwd, input),
    gatherParent(exec, cwd, input),
    gatherLabels(exec, cwd, input.team),
  ]);

  return {
    ...candidates,
    ...parent,
    ...labels,
    gaps: [...candidates.gaps, ...parent.gaps, ...labels.gaps],
  };
};

export const createTrackerEvidenceTool = (
  exec: Exec,
): ToolDefinition<typeof trackerEvidenceParameters, TrackerEvidence> =>
  defineTool({
    name: 'tracker_evidence',
    label: 'Tracker evidence',
    description,
    promptSnippet: 'Read duplicate candidates, parent routing, and labels for a planned ticket.',
    parameters: trackerEvidenceParameters,
    defaultActive: false,
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      const details = await gatherEvidence(exec, context.cwd, parameters);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
