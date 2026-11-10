import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import type { ConfigLocation } from '../../config/config.js';
import { confirmWithUser } from '../../dialog/dialog.js';
import { errorMessage } from '../../errors.js';
import { createIssue, readRouteIds, updateIssue } from '../../linear/linear.js';
import { isViewersTicket } from '../../linear/ownership.js';
import { readOptionalText } from '../../record.js';
import {
  checkTauDirectory,
  findTauRoot,
  rejectLinkedFile,
  requireTauChild,
} from '../../tauDirectory.js';
import { isWorkerProcess } from '../../worker.js';
import { readRepositorySetup } from './config.js';
import type { TrackerRoute } from './config.js';
import { readDraftRecord, writeDraftRecord } from './draftRecord.js';
import { readTicketIssue, searchIssues } from './linear.js';
import { trackerLines } from './promptLines.js';
import { planTicketWrites } from './ticketWrites.js';
import type { TicketArguments, TicketDraft, TicketWrite } from './ticketWrites.js';

export interface TicketRuntime {
  exec: Exec;
  context: ExtensionContext;
  location: ConfigLocation;
}

export interface TicketReadDetails {
  directory: string;
  identifier: string | null;
  route: TrackerRoute | null;
  current: TicketDraft | null;
  writes: TicketWrite[];
  problems: string[];
  stateToken: string;
}

export interface TicketApplyDetails {
  status: 'created' | 'updated' | 'unchanged' | 'declined';
  identifier: string | null;
  url: string | null;
}

const readDirectory = async (cwd: string, requested: string) => {
  const root = await findTauRoot(cwd, 'ticket');
  const directory = resolve(cwd, requested);
  const name = requireTauChild(root, 'tickets', '', directory, 'Ticket directory');

  await checkTauDirectory(root, `tickets/${name}`);

  await Promise.all(
    ['title.md', 'ticket.md', 'draft.json'].map((file) =>
      rejectLinkedFile(join(directory, file), 'read'),
    ),
  );

  return directory;
};

const readTicketRoute = async ({ exec, context, location }: TicketRuntime) => {
  const facts = await readRepositorySetup(exec, location, context.ui);
  const route = facts.setup.status === 'read' ? facts.setup.route : undefined;

  const routeProblem =
    trackerLines(facts)
      .filter((line) => line.startsWith('Tracker setup needed:'))
      .join('\n') || 'Tracker setup needed: configure tracker.repositories for this repository.';

  return { route, routeProblem };
};

const readCreateTargets = async (
  runtime: TicketRuntime,
  request: TicketArguments,
  route: TrackerRoute | undefined,
) => {
  if (route === undefined) {
    throw new Error('Tracker setup needed: no route.');
  }

  const { exec, context } = runtime;

  const routeIds = await readRouteIds(exec, context.cwd, {
    team: route.team,
    project: route.project ?? null,
  });

  const parent =
    request.parent === undefined ? null : await readTicketIssue(exec, context.cwd, request.parent);

  return { routeIds, parent };
};

const readCreateCandidates = async (
  runtime: TicketRuntime,
  route: TrackerRoute | undefined,
  identifier: string | null,
  title: string,
) => {
  if (identifier !== null || route === undefined) {
    return [];
  }

  const { exec, context } = runtime;

  const found = await searchIssues(exec, context.cwd, {
    team: route.team,
    project: route.project ?? null,
    keywords: title,
  });

  if (found.hasNextPage) {
    throw new Error(
      'Ticket search has another page. Cannot rule out an unrecorded ticket. Nothing was written.',
    );
  }

  return Promise.all(
    found.issues.map((issue) => readTicketIssue(exec, context.cwd, issue.identifier)),
  );
};

const readState = async (runtime: TicketRuntime, request: TicketArguments) => {
  const { exec, context } = runtime;
  const directory = await readDirectory(context.cwd, request.directory);
  const titleFile = await readFile(join(directory, 'title.md'), 'utf8');
  const description = await readFile(join(directory, 'ticket.md'), 'utf8');
  const recordFile = await readOptionalText(join(directory, 'draft.json'));
  const record = await readDraftRecord(directory);
  const draft = { title: titleFile.trim(), description };
  const { route, routeProblem } = await readTicketRoute(runtime);
  const identifier = record?.identifier ?? null;
  const current = identifier === null ? null : await readTicketIssue(exec, context.cwd, identifier);
  const candidates = await readCreateCandidates(runtime, route, identifier, draft.title);
  const plan = planTicketWrites({ draft, request, route, routeProblem, current, candidates });
  const creating = plan.writes[0]?.kind === 'createTicket';
  const targets = creating ? await readCreateTargets(runtime, request, route) : null;

  const stateToken = createHash('sha256')
    .update(
      JSON.stringify({
        directory,
        titleFile,
        description,
        recordFile,
        request,
        route,
        targets,
        current,
        candidates,
      }),
    )
    .digest('hex');

  return {
    directory,
    identifier,
    route: route ?? null,
    current,
    ...plan,
    stateToken,
    record,
    draft,
    targets,
  };
};

export const readTicket = async (
  runtime: TicketRuntime,
  request: TicketArguments,
): Promise<TicketReadDetails> => {
  const { directory, identifier, route, current, writes, problems, stateToken } = await readState(
    runtime,
    request,
  );

  return { directory, identifier, route, current, writes, problems, stateToken };
};

const rejectChangedState = (actual: string, expected: string) => {
  if (actual !== expected) {
    throw new Error('Ticket state changed. Call read again. Nothing was written.');
  }
};

const approveUpdate = async (
  runtime: TicketRuntime,
  state: Awaited<ReturnType<typeof readState>>,
) => {
  if (state.current === null || isViewersTicket(state.current.viewer, state.current)) {
    return true;
  }

  if (!runtime.context.hasUI || isWorkerProcess()) {
    return false;
  }

  return confirmWithUser(runtime.context, {
    action: 'Updating a ticket another person owns',
    title: `Update ${state.current.identifier} in Linear`,
    message: `Current title:\n${state.current.title}\n\nCurrent description:\n${state.current.description}\n\nNew title:\n${state.draft.title}\n\nNew description:\n${state.draft.description}`,
  });
};

const applyCreate = async (
  runtime: TicketRuntime,
  state: Awaited<ReturnType<typeof readState>>,
  request: TicketArguments,
): Promise<TicketApplyDetails> => {
  if (state.targets === null) {
    throw new Error('Tracker setup needed: no create targets.');
  }

  const created = await createIssue(runtime.exec, runtime.context.cwd, {
    ...state.targets.routeIds,
    ...state.draft,
    parent: state.targets.parent?.id ?? null,
    labels: request.labels ?? [],
    subIssueSortOrder: undefined,
  });

  try {
    await writeDraftRecord(state.directory, {
      version: 3,
      identifier: created.identifier,
      comments: state.record?.comments ?? {},
    });
  } catch (error) {
    throw new Error(
      `Created ${created.identifier} (${created.url}), but could not save its identifier in ${state.directory}/draft.json: ${errorMessage(error)}. Call read again to check the unrecorded ticket.`,
      { cause: error },
    );
  }

  return { status: 'created', identifier: created.identifier, url: created.url };
};

export const applyTicket = async (
  runtime: TicketRuntime,
  request: TicketArguments & { stateToken: string },
): Promise<TicketApplyDetails> => {
  const { stateToken, ...argumentsWithoutToken } = request;
  const state = await readState(runtime, argumentsWithoutToken);

  rejectChangedState(state.stateToken, stateToken);

  if (state.problems.length > 0) {
    throw new Error(state.problems.join('\n'));
  }

  const write = state.writes[0];
  const details = { identifier: state.identifier, url: state.current?.url ?? null };

  if (write === undefined) {
    return { status: 'unchanged', ...details };
  }

  if (state.current !== null) {
    const approved = await approveUpdate(runtime, state);

    if (!approved) {
      return { status: 'declined', ...details };
    }

    if (!isViewersTicket(state.current.viewer, state.current)) {
      const reread = await readState(runtime, argumentsWithoutToken);

      rejectChangedState(reread.stateToken, stateToken);
    }

    await updateIssue(runtime.exec, runtime.context.cwd, state.current.identifier, write);

    return { status: 'updated', ...details };
  }

  return applyCreate(runtime, state, request);
};
