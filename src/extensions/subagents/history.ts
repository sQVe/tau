import { dirname, join } from 'node:path';

import { truncateLine } from '@earendil-works/pi-coding-agent';

import { isMissingFile } from '../../errors.js';
import { readWorkerFacts } from './controller/record.js';
import { nativeHeader } from './native.js';
import { findSuccessor, readReport, readTask } from './records.js';
import { canonical, historyRegistry, lineage, sameRoot } from './sessionLineage.js';
import type { LineageNode } from './sessionLineage.js';
import { isTaskId } from './types.js';
import type { Report, Task, WorkerState } from './types.js';
import { deriveWorkerState } from './workerState.js';

interface Candidate {
  sourceFile: string;
  taskId: string;
  predecessorTaskId?: string;
  successorTaskId?: string;
  name?: string;
  description: string;
  nativeSessionId?: string;
  nativeSessionFile?: string;
  nativeEvidence: 'available' | 'missing' | 'invalid';
  state?: WorkerState;
  report?: Report;
}

interface AuthorizedHistoryTask {
  directory: string;
  task: Task;
  origin: Task;
}

interface HistorySearch {
  outcome: string;
  candidates: Candidate[];
  diagnostics: string[];
}

interface HistoryPage {
  outcome: string;
  totalMatches: number;
  nextOffset?: number;
  candidates: CandidatePreview[];
  diagnostics?: string[];
}

type Ownership = (taskId: string) => boolean;

type InScope = (file: string, id?: string) => boolean;

// A saved task this Tau cannot read names its own reason, such as a retired non-Pi worker.
const refuseUnreadableTask = (directory: string): void => {
  try {
    readTask(directory);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
};

export const authorizeHistoryTask = (
  root: string,
  current: { file: string; id: string },
  taskId: string,
): AuthorizedHistoryTask => {
  if (!isTaskId(taskId)) {
    throw new Error('Follow-up requires an exact saved task ID.');
  }

  const { saved, origins } = historyRegistry(root);
  const selected = saved.find(({ task }) => task.taskId === taskId);
  const origin = origins.get(taskId);

  if (!selected || !origin) {
    refuseUnreadableTask(join(root, taskId));

    throw new Error(
      'Unknown task or invalid continuation chain. Native-only sessions cannot be followed up.',
    );
  }

  const currentRoot = lineage(current.file, current.id).at(-1);

  const parentRoot = lineage(selected.task.parentSession, selected.task.parentSessionId).at(-1);

  const nativeRoot = lineage(origin.parentSession, origin.parentSessionId).at(-1);

  if (!currentRoot || !sameRoot(parentRoot, currentRoot) || !sameRoot(nativeRoot, currentRoot)) {
    throw new Error('Task is outside the authorized current-root tree.');
  }

  return { ...selected, origin };
};

// Internal display budget for one history page.
const historyByteBudget = 48_000;

// One unreadable record must not hide the rest of history. Follow-up authorization still fails closed.
const readOrDiagnose = <T>(read: () => T, label: string, diagnostics: string[]): T | undefined => {
  try {
    return read();
  } catch (error) {
    diagnostics.push(`${label}: ${String(error)}`);

    return undefined;
  }
};

const candidateState = (
  directory: string,
  task: Task,
  ownership: Ownership,
  diagnostics: string[],
): Pick<Candidate, 'state'> => {
  const facts = readOrDiagnose(
    () => readWorkerFacts(directory, task.taskId),
    `Task ${task.taskId} state`,
    diagnostics,
  );

  if (!facts) {
    return {};
  }

  const state = deriveWorkerState(facts, ownership(task.taskId));

  return { state };
};

const readNativeEvidence = (
  task: Task,
  origin: Task,
  diagnostics: string[],
): Candidate['nativeEvidence'] => {
  try {
    const header = nativeHeader(canonical(task.nativeSessionFile));

    if (header.id !== origin.nativeSessionId || header.cwd !== origin.loadout.cwd) {
      throw new Error('Saved native session identity does not match its task.');
    }

    if (header.parentSession == null || header.parentSession === '') {
      throw new Error('Saved native session parent is missing.');
    }

    if (canonical(header.parentSession) !== canonical(origin.parentSession)) {
      throw new Error('Saved native session ancestry does not match its task.');
    }

    return 'available';
  } catch (error) {
    if (isMissingFile(error)) {
      return 'missing';
    }

    diagnostics.push(`Task ${task.taskId}: ${String(error)}`);

    return 'invalid';
  }
};

const taskCandidate = (
  { directory, task }: { directory: string; task: Task },
  tasks: Map<string, Task>,
  inScope: (file: string, id?: string) => boolean,
  ownership: Ownership,
  diagnostics: string[],
): Candidate | undefined => {
  let origin: Task | undefined;

  try {
    origin = tasks.get(canonical(task.nativeSessionFile));

    if (
      !origin ||
      !inScope(origin.parentSession, origin.parentSessionId) ||
      !inScope(task.parentSession, task.parentSessionId)
    ) {
      return undefined;
    }
  } catch {
    diagnostics.push('Excluded a task with unverified parent ancestry.');

    return undefined;
  }

  const nativeEvidence = readNativeEvidence(task, origin, diagnostics);

  const report = readOrDiagnose(
    () => readReport(directory, task.taskId),
    `Task ${task.taskId} report`,
    diagnostics,
  );

  const state = candidateState(directory, task, ownership, diagnostics);

  return {
    sourceFile: join(directory, 'task.json'),
    taskId: task.taskId,
    ...(task.predecessorTaskId != null ? { predecessorTaskId: task.predecessorTaskId } : {}),
    ...(task.name != null ? { name: task.name } : {}),
    description: task.task,
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    nativeEvidence,
    ...state,
    ...(report ? { report } : {}),
  };
};

const searchOutcome = (query: string, count: number): string => {
  if (!query) {
    return 'list';
  }

  if (count === 0) {
    return 'notFound';
  }

  return count === 1 ? 'match' : 'clarification';
};

// The caller's own task names the current native session, so its own task and every task that owns
// an ancestor session are not history candidates for that caller.
const ownsAncestorSession = (task: Task, ancestorFiles: Set<string>): boolean =>
  ancestorFiles.has(canonical(task.nativeSessionFile));

const createScopeTest = (origin: LineageNode): InScope => {
  return (file: string, id?: string) => {
    const chain = lineage(file, id);
    const ancestor = chain.at(-1);

    return ancestor?.file === origin.file && ancestor.header.id === origin.header.id;
  };
};

const taskCandidates = (
  saved: { directory: string; task: Task }[],
  tasks: Map<string, Task>,
  inScope: InScope,
  ancestorFiles: Set<string>,
  ownership: Ownership,
  diagnostics: string[],
): Candidate[] => {
  const candidates: Candidate[] = [];

  for (const entry of saved) {
    if (ownsAncestorSession(entry.task, ancestorFiles)) {
      continue;
    }

    const candidate = taskCandidate(entry, tasks, inScope, ownership, diagnostics);

    if (candidate) {
      const successor = readOrDiagnose(
        () => findSuccessor(saved, entry.task.taskId),
        `Task ${entry.task.taskId} successor`,
        diagnostics,
      );

      if (successor) {
        candidate.successorTaskId = successor.taskId;
      }

      candidates.push(candidate);
    }
  }

  return candidates;
};

const candidateMatches = (candidate: Candidate, needle: string): boolean => {
  if (!needle) {
    return true;
  }

  return [candidate.taskId, candidate.name, candidate.description, candidate.nativeSessionId].some(
    (value) => value?.toLowerCase().includes(needle) === true,
  );
};

const matchCandidates = (candidates: Candidate[], needle: string): Candidate[] =>
  candidates
    .filter((candidate) => candidateMatches(candidate, needle))
    .toSorted((left, right) => left.taskId.localeCompare(right.taskId));

/* oxlint-disable typescript/require-await -- Keep the asynchronous history API for callers. */
export const searchHistory = async (
  root: string,
  current: { file: string; id: string },
  query = '',
  ownership: Ownership = () => false,
): Promise<HistorySearch> => {
  const { saved, tasks, diagnostics } = historyRegistry(root);
  const ancestors = lineage(current.file, current.id);
  const origin = ancestors.at(-1);

  if (!origin) {
    throw new Error('Current session ancestry is unavailable.');
  }

  const inScope = createScopeTest(origin);
  const ancestorFiles = new Set(ancestors.map((node) => node.file));
  const candidates = taskCandidates(saved, tasks, inScope, ancestorFiles, ownership, diagnostics);

  const needle = query.trim().toLowerCase();
  const matches = matchCandidates(candidates, needle);

  return {
    outcome: searchOutcome(needle, matches.length),
    candidates: matches,
    diagnostics,
  };
};

/* oxlint-enable typescript/require-await */

const preview = (value: string, field: string, truncatedFields: string[], length = 500): string => {
  const result = truncateLine(value, length);

  if (result.wasTruncated) {
    truncatedFields.push(field);
  }

  return result.text;
};

const previewOptionalText = (
  value: string | undefined,
  field: string,
  truncatedFields: string[],
): Record<string, unknown> =>
  value != null && value !== '' ? { [field]: preview(value, field, truncatedFields) } : {};

const candidateReport = (
  report: Report | undefined,
  summary: string | undefined,
  evidence: string[] | undefined,
) => {
  if (!report) {
    return {};
  }

  return {
    report: { outcome: report.outcome, summary, evidence },
    reportEvidenceCount: report.evidence.length,
  };
};

const previewEvidenceCount = 3;
const evidencePreviewLength = 200;

const candidatePreview = (candidate: Candidate) => {
  const truncatedFields: string[] = [];
  const report = candidate.report;
  const summary = report ? preview(report.summary, 'report.summary', truncatedFields) : undefined;

  const evidence = report?.evidence
    .slice(0, previewEvidenceCount)
    .map((entry) => preview(entry, 'report.evidence', truncatedFields, evidencePreviewLength));

  if (report && report.evidence.length > previewEvidenceCount) {
    truncatedFields.push('report.evidence');
  }

  const reportTruncated = truncatedFields.length > 0;
  const nativeOnly = candidate.nativeEvidence !== 'available';

  const result = {
    ...previewOptionalText(candidate.taskId, 'taskId', truncatedFields),
    ...previewOptionalText(candidate.predecessorTaskId, 'predecessorTaskId', truncatedFields),
    ...previewOptionalText(candidate.successorTaskId, 'successorTaskId', truncatedFields),
    ...previewOptionalText(candidate.name, 'name', truncatedFields),
    description: preview(candidate.description, 'description', truncatedFields),
    ...(candidate.state ? { state: candidate.state } : {}),
    ...previewOptionalText(candidate.nativeSessionId, 'nativeSessionId', truncatedFields),
    nativeEvidence: candidate.nativeEvidence,
    ...candidateReport(report, summary, evidence),
    ...(reportTruncated ? { reportFile: join(dirname(candidate.sourceFile), 'report.json') } : {}),
    ...(nativeOnly
      ? previewOptionalText(candidate.nativeSessionFile, 'nativeSessionFile', truncatedFields)
      : {}),
  };

  return truncatedFields.length > 0
    ? { ...result, truncatedFields: [...new Set(truncatedFields)] }
    : result;
};

type CandidatePreview = ReturnType<typeof candidatePreview>;

const isHistoryOffsetValid = (offset: number): boolean =>
  Number.isSafeInteger(offset) && offset >= 0;

const maximumHistoryLimit = 10;
const previewDiagnosticCount = 5;

const isHistoryLimitValid = (limit: number): boolean =>
  Number.isSafeInteger(limit) && limit >= 1 && limit <= maximumHistoryLimit;

export const historyPage = (
  history: HistorySearch,
  offset = 0,
  limit = maximumHistoryLimit,
): HistoryPage => {
  if (!isHistoryOffsetValid(offset) || !isHistoryLimitValid(limit)) {
    throw new Error('History offset must be nonnegative and limit must be between 1 and 10.');
  }

  const diagnosticFields: string[] = [];

  const diagnostics = history.diagnostics
    .slice(0, previewDiagnosticCount)
    .map((entry) => preview(entry, 'diagnostics', diagnosticFields));

  const candidates: CandidatePreview[] = [];

  const page = (nextOffset?: number) => ({
    outcome: history.outcome,
    totalMatches: history.candidates.length,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    candidates,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  });

  for (const candidate of history.candidates.slice(offset, offset + limit)) {
    candidates.push(candidatePreview(candidate));
    const size = Buffer.byteLength(JSON.stringify(page(offset + candidates.length)), 'utf8');

    if (size > historyByteBudget) {
      candidates.pop();

      if (candidates.length === 0) {
        throw new Error(
          'A history reference exceeds the display budget. Inspect saved session/task files directly.',
        );
      }

      break;
    }
  }

  const next = offset + candidates.length;

  return page(next < history.candidates.length ? next : undefined);
};
