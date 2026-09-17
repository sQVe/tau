import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { SessionManager, truncateLine } from '@earendil-works/pi-coding-agent';
import type { SessionInfo } from '@earendil-works/pi-coding-agent';

import { continuationOrigins } from './continuations.js';
import { readNative } from './native.js';
import { readReport, readSuccessor, readTasks } from './records.js';
import type { Report, Task } from './types.js';

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const canonical = (path: string): string => {
  if (!isAbsolute(path)) {
    throw new Error('Session lineage requires absolute paths.');
  }
  try {
    return realpathSync(path);
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }

    return resolve(path);
  }
};

const readNode = (file: string, tasks: Map<string, Task>) => {
  const task = tasks.get(file);
  let header;
  let unavailable = false;
  try {
    header = readNative(file).header;
  } catch (error) {
    if (!missing(error) || !task) {
      throw new Error(`Session ancestry is unavailable: ${String(error)}`, { cause: error });
    }
    unavailable = true;
    header = {
      type: 'session' as const,
      version: 3 as const,
      id: task.nativeSessionId,
      cwd: task.loadout.cwd,
      parentSession: task.parentSession,
    };
  }
  if (
    task &&
    (header.id !== task.nativeSessionId ||
      !header.parentSession ||
      canonical(header.parentSession) !== canonical(task.parentSession) ||
      header.cwd !== task.loadout.cwd)
  ) {
    throw new Error('Saved native session identity or ancestry does not match its task.');
  }

  return { file, header, unavailable, task };
};

const lineage = (file: string, tasks: Map<string, Task>, expectedId?: string) => {
  const nodes = [];
  const seen = new Set<string>();
  let next: string | undefined = file;
  let expected = expectedId;
  while (next) {
    const path = canonical(next);
    if (seen.has(path) || seen.size >= 1024) {
      throw new Error('Cyclic or excessive session ancestry.');
    }
    seen.add(path);
    const node = readNode(path, tasks);
    if (expected !== undefined && node.header.id !== expected) {
      throw new Error('Session lineage identity mismatch.');
    }
    nodes.push(node);
    next = node.header.parentSession;
    expected = node.task?.parentSessionId;
  }

  return nodes;
};

const historyRegistry = (root: string) => {
  const scanDiagnostics: string[] = [];
  const entries = readTasks(root, scanDiagnostics);
  const { origins, diagnostics } = continuationOrigins(entries);
  diagnostics.push(...scanDiagnostics);
  const tasks = new Map<string, Task>();
  for (const origin of origins.values()) {
    const path = canonical(origin.nativeSessionFile);
    if (tasks.has(path) && tasks.get(path)?.taskId !== origin.taskId) {
      throw new Error('Conflicting saved native session identities.');
    }
    tasks.set(path, origin);
  }

  return {
    saved: entries.filter(({ task }) => origins.has(task.taskId)),
    origins,
    tasks,
    diagnostics,
  };
};

export const authorizeHistoryTask = (
  root: string,
  current: { file: string; id: string },
  taskId: string,
) => {
  if (!/^[a-zA-Z0-9-]+$/.test(taskId)) {
    throw new Error('Follow-up requires an exact saved task ID.');
  }
  const { saved, origins, tasks } = historyRegistry(root);
  const selected = saved.find(({ task }) => task.taskId === taskId);
  const origin = origins.get(taskId);
  if (!selected || !origin) {
    throw new Error(
      'Unknown task or invalid continuation chain. Native-only sessions cannot be followed up.',
    );
  }
  const currentRoot = lineage(current.file, tasks, current.id).at(-1);
  const parentRoot = lineage(selected.task.parentSession, tasks, selected.task.parentSessionId).at(
    -1,
  );
  const nativeRoot = lineage(origin.parentSession, tasks, origin.parentSessionId).at(-1);
  if (
    !currentRoot ||
    parentRoot?.file !== currentRoot.file ||
    parentRoot.header.id !== currentRoot.header.id ||
    nativeRoot?.file !== currentRoot.file ||
    nativeRoot.header.id !== currentRoot.header.id
  ) {
    throw new Error('Task is outside the authorized current-root tree.');
  }

  return { ...selected, origin };
};

interface Candidate {
  sourceFile: string;
  taskId?: string;
  predecessorTaskId?: string;
  successorTaskId?: string;
  name?: string;
  description: string;
  nativeSessionId: string;
  nativeSessionFile: string;
  nativeEvidence: 'available' | 'missing' | 'invalid';
  report?: Report;
}

// One unreadable record must not hide the rest of history. Follow-up authorization still fails closed.
const readOrDiagnose = <T>(read: () => T, label: string, diagnostics: string[]): T | undefined => {
  try {
    return read();
  } catch (error) {
    diagnostics.push(`${label}: ${String(error)}`);

    return undefined;
  }
};

const taskCandidate = (
  { directory, task }: { directory: string; task: Task },
  tasks: Map<string, Task>,
  inScope: (file: string, id?: string) => boolean,
  diagnostics: string[],
): Candidate | undefined => {
  try {
    const origin = tasks.get(canonical(task.nativeSessionFile));
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
  let nativeEvidence: Candidate['nativeEvidence'] = 'available';
  try {
    const node = readNode(canonical(task.nativeSessionFile), tasks);
    nativeEvidence = node.unavailable ? 'missing' : 'available';
  } catch (error) {
    nativeEvidence = 'invalid';
    diagnostics.push(`Task ${task.taskId}: ${String(error)}`);
  }
  const report = readOrDiagnose(
    () => readReport(directory, task.taskId),
    `Task ${task.taskId} report`,
    diagnostics,
  );
  const successor = readOrDiagnose(
    () => readSuccessor(directory),
    `Task ${task.taskId} successor claim`,
    diagnostics,
  );

  return {
    sourceFile: join(directory, 'task.json'),
    taskId: task.taskId,
    ...(task.predecessorTaskId ? { predecessorTaskId: task.predecessorTaskId } : {}),
    ...(successor ? { successorTaskId: successor.successorTaskId } : {}),
    ...(task.name ? { name: task.name } : {}),
    description: task.task,
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    nativeEvidence,
    ...(report ? { report } : {}),
  };
};

const searchOutcome = (query: string, count: number): string => {
  if (!query) {
    return 'list';
  }
  if (!count) {
    return 'notFound';
  }

  return count === 1 ? 'match' : 'clarification';
};

export const searchHistory = async (
  root: string,
  current: { file: string; id: string; sessionDirectory: string },
  query = '',
) => {
  const { saved, tasks, diagnostics } = historyRegistry(root);
  const ancestors = lineage(current.file, tasks, current.id);
  const origin = ancestors.at(-1);
  if (!origin) {
    throw new Error('Current session ancestry is unavailable.');
  }
  const inScope = (file: string, id?: string) => {
    const chain = lineage(file, tasks, id);
    const ancestor = chain.at(-1);

    return ancestor?.file === origin.file && ancestor.header.id === origin.header.id;
  };
  const candidates: Candidate[] = [];
  for (const entry of saved) {
    const candidate = taskCandidate(entry, tasks, inScope, diagnostics);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  // ponytail: scan retained metadata per query; add an index only if retained history makes this slow.
  const directories = new Set([
    current.sessionDirectory,
    ...ancestors.map((node) => dirname(node.file)),
    ...saved.flatMap(({ task }) => [dirname(task.parentSession), dirname(task.nativeSessionFile)]),
  ]);
  const discovered = await Promise.all([
    SessionManager.listAll(),
    ...Array.from(directories, (directory) => SessionManager.listAll(directory)),
  ]);
  const sessions = new Map<string, Pick<SessionInfo, 'id' | 'name' | 'firstMessage'>>(
    ancestors.map((node) => [
      node.file,
      { id: node.header.id, firstMessage: '(Native session header; no discovered description.)' },
    ]),
  );
  for (const session of discovered.flat()) {
    const path = canonical(session.path);
    const seeded = sessions.get(path);
    if (seeded && seeded.id !== session.id) {
      diagnostics.push('Discovered metadata disagrees with a validated session identity.');
      continue;
    }
    sessions.set(path, session);
  }
  for (const [path, session] of sessions) {
    if (tasks.has(path)) {
      continue;
    }
    try {
      if (inScope(path, session.id)) {
        candidates.push({
          sourceFile: path,
          ...(session.name ? { name: session.name } : {}),
          description: session.firstMessage,
          nativeSessionId: session.id,
          nativeSessionFile: path,
          nativeEvidence: 'available',
        });
      }
    } catch {
      diagnostics.push('Excluded a native session with unverified ancestry.');
    }
  }
  const needle = query.trim().toLowerCase();
  const matches = candidates
    .filter(
      (candidate) =>
        !needle ||
        [candidate.taskId, candidate.name, candidate.description, candidate.nativeSessionId].some(
          (value) => value?.toLowerCase().includes(needle),
        ),
    )
    .toSorted((left, right) =>
      (left.taskId ?? left.nativeSessionId).localeCompare(right.taskId ?? right.nativeSessionId),
    );

  return {
    rootSessionId: origin.header.id,
    rootSessionFile: origin.file,
    outcome: searchOutcome(needle, matches.length),
    candidates: matches,
    diagnostics,
    readOnly: true,
  };
};

const preview = (value: string, field: string, truncatedFields: string[], length = 500): string => {
  const result = truncateLine(value, length);
  if (result.wasTruncated) {
    truncatedFields.push(field);
  }

  return result.text;
};

const candidatePreview = (candidate: Candidate) => {
  const truncatedFields: string[] = [];
  const report = candidate.report;
  const summary = report ? preview(report.summary, 'report.summary', truncatedFields) : undefined;
  const evidence = report?.evidence
    .slice(0, 3)
    .map((entry) => preview(entry, 'report.evidence', truncatedFields, 200));
  if (report && report.evidence.length > 3) {
    truncatedFields.push('report.evidence');
  }

  return {
    sourceFile: candidate.sourceFile,
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
    ...(candidate.predecessorTaskId
      ? {
          predecessorTaskId: preview(
            candidate.predecessorTaskId,
            'predecessorTaskId',
            truncatedFields,
          ),
        }
      : {}),
    ...(candidate.successorTaskId
      ? { successorTaskId: preview(candidate.successorTaskId, 'successorTaskId', truncatedFields) }
      : {}),
    ...(candidate.name ? { name: preview(candidate.name, 'name', truncatedFields) } : {}),
    description: preview(candidate.description, 'description', truncatedFields),
    nativeSessionId: preview(candidate.nativeSessionId, 'nativeSessionId', truncatedFields),
    nativeSessionFile: preview(candidate.nativeSessionFile, 'nativeSessionFile', truncatedFields),
    nativeEvidence: candidate.nativeEvidence,
    ...(report
      ? {
          report: { outcome: report.outcome, summary, evidence },
          reportEvidenceCount: report.evidence.length,
          reportFileRelativeToSource: 'report.json',
        }
      : {}),
    truncatedFields: [...new Set(truncatedFields)],
  };
};

export const historyPage = (
  history: Awaited<ReturnType<typeof searchHistory>>,
  offset = 0,
  limit = 10,
) => {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10
  ) {
    throw new Error('History offset must be nonnegative and limit must be between 1 and 10.');
  }
  const truncatedFields: string[] = [];
  const page = {
    rootSessionId: preview(history.rootSessionId, 'rootSessionId', truncatedFields),
    rootSessionFile: preview(history.rootSessionFile, 'rootSessionFile', truncatedFields),
    outcome: history.outcome,
    totalMatches: history.candidates.length,
    offset,
    limit,
    nextOffset: null as number | null,
    candidates: [] as ReturnType<typeof candidatePreview>[],
    diagnostics: history.diagnostics
      .slice(0, 5)
      .map((entry) => preview(entry, 'diagnostics', truncatedFields)),
    totalDiagnostics: history.diagnostics.length,
    diagnosticsTruncated: history.diagnostics.length > 5 || truncatedFields.includes('diagnostics'),
    truncatedFields,
    maxBytes: 48000,
    readOnly: true,
    retrieval:
      'Read sourceFile for the complete task record or native transcript. reportFileRelativeToSource is a sibling of sourceFile. Task records contain full native references. Truncated fields are previews, not exact identifiers or paths. subagent_status remains direct-parent-only.',
    paging:
      'Repeat the same query with nextOffset. History is recomputed; concurrent additions can change pages.',
  };
  for (const candidate of history.candidates.slice(offset, offset + limit)) {
    page.candidates.push(candidatePreview(candidate));
    page.nextOffset = offset + page.candidates.length;
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > page.maxBytes) {
      page.candidates.pop();
      if (!page.candidates.length) {
        throw new Error(
          'A history reference exceeds the display budget. Inspect saved session/task files directly.',
        );
      }
      break;
    }
  }
  const next = offset + page.candidates.length;
  page.nextOffset = next < history.candidates.length ? next : null;

  return page;
};
