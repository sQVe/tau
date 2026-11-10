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
import { trackerSetupDiagnostic } from './setupDiagnostic.js';
import { planTicketWrites } from './ticketWrites.js';
import type { TicketArguments, TicketDraft, TicketPlan, TicketWrite } from './ticketWrites.js';

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

type ReadyTicketPlan = ReadyCreatePlan | Exclude<TicketPlan, { kind: 'create' }>;

type CreateState = TicketState & { plan: ReadyCreatePlan };

type UpdateState = TicketState & { plan: Extract<TicketPlan, { kind: 'update' }> };

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

  const diagnostic = trackerSetupDiagnostic(facts);

  return { route, routeProblem: diagnostic.problem };
};

const readCreateTargets = async (
  runtime: TicketRuntime,
  request: TicketArguments,
  route: TrackerRoute,
) => {
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

type ReadyCreatePlan = Extract<TicketPlan, { kind: 'create' }> & {
  targets: Awaited<ReturnType<typeof readCreateTargets>>;
};

const prepareTicketPlan = async (
  runtime: TicketRuntime,
  request: TicketArguments,
  plan: TicketPlan,
): Promise<ReadyTicketPlan> => {
  if (plan.kind === 'create') {
    const targets = await readCreateTargets(runtime, request, plan.route);

    return { ...plan, targets };
  }

  return plan;
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
  const planned = planTicketWrites({ draft, request, route, routeProblem, current, candidates });
  const plan = await prepareTicketPlan(runtime, request, planned);
  const targets = plan.kind === 'create' ? plan.targets : null;

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
    plan,
    stateToken,
    record,
    draft,
  };
};

export const readTicket = async (
  runtime: TicketRuntime,
  request: TicketArguments,
): Promise<TicketReadDetails> => {
  const { directory, identifier, route, current, plan, stateToken } = await readState(
    runtime,
    request,
  );

  return {
    directory,
    identifier,
    route,
    current,
    writes: plan.writes,
    problems: plan.problems,
    stateToken,
  };
};

const rejectChangedState = (actual: string, expected: string) => {
  if (actual !== expected) {
    throw new Error('Ticket state changed. Call read again. Nothing was written.');
  }
};

type TicketState = Awaited<ReturnType<typeof readState>>;

const approveUpdate = async (runtime: TicketRuntime, state: UpdateState) => {
  const { current } = state.plan;

  if (isViewersTicket(current.viewer, current)) {
    return true;
  }

  if (!runtime.context.hasUI || isWorkerProcess()) {
    return false;
  }

  return confirmWithUser(runtime.context, {
    action: 'Updating a ticket another person owns',
    title: `Update ${current.identifier} in Linear`,
    message: `Current title:\n${current.title}\n\nCurrent description:\n${current.description}\n\nNew title:\n${state.draft.title}\n\nNew description:\n${state.draft.description}`,
  });
};

const applyCreate = async (
  runtime: TicketRuntime,
  state: CreateState,
  request: TicketArguments,
): Promise<TicketApplyDetails> => {
  const { targets, write } = state.plan;

  const created = await createIssue(runtime.exec, runtime.context.cwd, {
    ...targets.routeIds,
    title: write.title,
    description: write.description,
    parent: targets.parent?.id ?? null,
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

const applyUpdate = async (
  runtime: TicketRuntime,
  state: UpdateState,
  request: TicketArguments,
): Promise<TicketApplyDetails> => {
  const { current, write } = state.plan;
  const details = { identifier: state.identifier, url: current.url };
  const approved = await approveUpdate(runtime, state);

  if (!approved) {
    return { status: 'declined', ...details };
  }

  if (!isViewersTicket(current.viewer, current)) {
    const reread = await readState(runtime, request);

    rejectChangedState(reread.stateToken, state.stateToken);
  }

  await updateIssue(runtime.exec, runtime.context.cwd, current.identifier, write);

  return { status: 'updated', ...details };
};

export const applyTicket = async (
  runtime: TicketRuntime,
  request: TicketArguments & { stateToken: string },
): Promise<TicketApplyDetails> => {
  const { stateToken, ...argumentsWithoutToken } = request;
  const state = await readState(runtime, argumentsWithoutToken);

  rejectChangedState(state.stateToken, stateToken);

  const { plan } = state;

  switch (plan.kind) {
    case 'blocked': {
      throw new Error(plan.problems.join('\n'));
    }

    case 'unchanged': {
      return { status: 'unchanged', identifier: state.identifier, url: plan.current.url };
    }

    case 'create': {
      return applyCreate(runtime, { ...state, plan }, argumentsWithoutToken);
    }

    case 'update': {
      return applyUpdate(runtime, { ...state, plan }, argumentsWithoutToken);
    }

    default: {
      return plan satisfies never;
    }
  }
};
