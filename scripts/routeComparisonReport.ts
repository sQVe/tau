import { isRecord } from '../src/schema.ts';

export type RecordKind = 'archive' | 'worker' | 'assignment';

export type Side = 'before' | 'after';

export interface RecordFile {
  kind: RecordKind;
  text: string;
  reportText?: string;
  reportTime?: number;
  sessionText?: string;
}

export interface RouteRecord {
  id: string;
  createdAt: number;
  parentSession?: string | undefined;
  profile?: string | undefined;
  model?: string | undefined;
  cwd?: string | undefined;
  label?: string | undefined;
  fallbackReason?: string | undefined;
  predecessorId?: string | undefined;
  outcome?: string | undefined;
  summary?: string | undefined;
  reportTime?: number | undefined;
}

export interface ComparisonOptions {
  profile: string;
  label: string;
  switch: number;
  model?: string;
  since?: number;
  until?: number;
}

export type ParsedRecord =
  | { kind: 'record'; record: RouteRecord }
  | { kind: 'pre-routing' }
  | { kind: 'skipped' };

export interface RouteComparisonReport {
  options: ComparisonOptions;
  before: SideReport;
  after: SideReport;
  skipped: number;
  preRouting: number;
  duplicateIds: number;
}

const routedTaskMinimumVersion = 8;
const millisecondsPerMinute = 60_000;
const minimumSampleSize = 20;

/* eslint-disable no-magic-numbers -- Saved record versions are schema numbers, not thresholds. */
const allowedVersions: Record<RecordKind, number[]> = {
  archive: [8, 9, 11],
  worker: [11, 13],
  assignment: [3],
};
/* eslint-enable no-magic-numbers */

const optionalText = (value: unknown) => (typeof value === 'string' ? value : undefined);

const integer = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

const objectOrEmpty = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const parseJson = (source: string | undefined): unknown => {
  if (source === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
};

const reportTimeOfEntry = (entry: unknown): number | undefined => {
  if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) {
    return undefined;
  }

  const { role, toolName, isError } = entry.message;

  if (role !== 'toolResult' || toolName !== 'subagent_report' || isError !== false) {
    return undefined;
  }

  const timestamp = optionalText(entry.timestamp);
  const time = timestamp === undefined ? undefined : Date.parse(timestamp);

  return time !== undefined && !Number.isNaN(time) ? time : undefined;
};

export const reportTimeFromSession = (source: string): number | undefined => {
  for (const line of source.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    try {
      const time = reportTimeOfEntry(JSON.parse(line));

      if (time !== undefined) {
        return time;
      }
    } catch {
      continue;
    }
  }

  return undefined;
};

const assignmentReportTime = (value: Record<string, unknown>, sessionText: string | undefined) =>
  isRecord(value.report) ? reportTimeFromSession(sessionText ?? '') : undefined;

const buildRecord = (
  file: RecordFile,
  value: Record<string, unknown>,
  id: string,
  createdAt: number,
): RouteRecord => {
  const routing = objectOrEmpty(value.routing);
  const loadout = objectOrEmpty(value.loadout);
  const reportValue = file.kind === 'assignment' ? value.report : parseJson(file.reportText);
  const report = objectOrEmpty(reportValue);

  const predecessor =
    file.kind === 'assignment' ? value.previousAssignmentId : value.predecessorTaskId;

  const topLevelProfile = file.kind === 'assignment' ? optionalText(value.profile) : undefined;
  const topLevelCwd = file.kind === 'assignment' ? optionalText(value.cwd) : undefined;

  return {
    id,
    createdAt,
    parentSession: optionalText(value.parentSession),
    profile: optionalText(loadout.profile) ?? topLevelProfile,
    model: optionalText(loadout.model),
    cwd: optionalText(loadout.cwd) ?? topLevelCwd,
    label: optionalText(routing.label),
    fallbackReason: optionalText(routing.fallbackReason),
    predecessorId: optionalText(predecessor),
    outcome: optionalText(report.outcome),
    summary: optionalText(report.summary),
    reportTime:
      file.kind === 'assignment' ? assignmentReportTime(value, file.sessionText) : file.reportTime,
  };
};

export const parseRouteRecord = (file: RecordFile): ParsedRecord => {
  const value = parseJson(file.text);

  if (!isRecord(value)) {
    return { kind: 'skipped' };
  }

  const version = integer(value.version);

  if (version === undefined) {
    return { kind: 'skipped' };
  }

  if (file.kind !== 'assignment' && version < routedTaskMinimumVersion) {
    return { kind: 'pre-routing' };
  }

  if (!allowedVersions[file.kind].includes(version)) {
    return { kind: 'skipped' };
  }

  const id =
    file.kind === 'assignment' ? optionalText(value.assignmentId) : optionalText(value.taskId);

  const createdAt = integer(value.createdAt);

  if (id === undefined || createdAt === undefined) {
    return { kind: 'skipped' };
  }

  return { kind: 'record', record: buildRecord(file, value, id, createdAt) };
};

const matchesRoute = (record: RouteRecord, options: ComparisonOptions) =>
  record.profile === options.profile && record.label === options.label;

const isCandidate = (record: RouteRecord, options: ComparisonOptions) =>
  record.predecessorId === undefined &&
  record.fallbackReason === undefined &&
  matchesRoute(record, options);

const sideOf = (record: RouteRecord, options: ComparisonOptions): Side | undefined => {
  if (record.createdAt < options.switch) {
    const outside = options.since !== undefined && record.createdAt < options.since;

    return outside ? undefined : 'before';
  }

  if (options.until !== undefined && record.createdAt >= options.until) {
    return undefined;
  }

  if (options.model !== undefined && record.model !== options.model) {
    return undefined;
  }

  return 'after';
};

const deduplicate = (records: RouteRecord[]) => {
  const seen = new Set<string>();
  const unique: RouteRecord[] = [];
  let duplicateIds = 0;

  for (const record of records) {
    if (seen.has(record.id)) {
      duplicateIds += 1;

      continue;
    }

    seen.add(record.id);
    unique.push(record);
  }

  return { unique, duplicateIds };
};

const chainGroups = (records: RouteRecord[], byId: Map<string, RouteRecord>) => {
  const groups = new Map<string, RouteRecord[]>();

  const rooted = (record: RouteRecord) => {
    let current = record;
    const seen = new Set<string>();

    while (current.predecessorId !== undefined) {
      if (seen.has(current.id)) {
        return undefined;
      }

      seen.add(current.id);

      const parent = byId.get(current.predecessorId);

      if (parent === undefined) {
        return undefined;
      }

      current = parent;
    }

    return current.id;
  };

  for (const record of records) {
    const root = rooted(record);

    if (root === undefined) {
      continue;
    }

    const group = groups.get(root) ?? [];

    group.push(record);
    groups.set(root, group);
  }

  return groups;
};

const firstReportMeasure = (launches: RouteRecord[]) => {
  const minutes = launches
    .filter((launch) => launch.reportTime !== undefined)
    .map((launch) => ((launch.reportTime ?? 0) - launch.createdAt) / millisecondsPerMinute);

  const sorted = minutes.toSorted((left, right) => left - right);
  const upper = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const lower = sorted[Math.ceil(sorted.length / 2) - 1] ?? 0;

  return {
    medianMinutes: minutes.length === 0 ? undefined : (lower + upper) / 2,
    measured: minutes.length,
    missing: launches.length - minutes.length,
  };
};

const followUpMeasure = (launches: RouteRecord[], groups: Map<string, RouteRecord[]>) => {
  const counts = launches.map((launch) => Math.max((groups.get(launch.id)?.length ?? 1) - 1, 0));
  const total = counts.reduce((sum, value) => sum + value, 0);
  const withFollowUp = counts.filter((value) => value > 0).length;
  const share = launches.length === 0 ? 0 : withFollowUp / launches.length;

  return { total, mean: launches.length === 0 ? 0 : total / launches.length, withFollowUp, share };
};

const successMeasure = (launches: RouteRecord[], groups: Map<string, RouteRecord[]>) => {
  const counts = { success: 0, failure: 0, incomplete: 0, withoutReport: 0 };

  for (const launch of launches) {
    const chain = groups.get(launch.id) ?? [launch];

    const last = chain.reduce((record, entry) =>
      entry.createdAt > record.createdAt ? entry : record,
    );

    const outcome = last.outcome;

    const kind =
      outcome === 'success' || outcome === 'failure' || outcome === 'incomplete'
        ? outcome
        : 'withoutReport';

    counts[kind] += 1;
  }

  return { ...counts, share: launches.length === 0 ? 0 : counts.success / launches.length };
};

const noFindingsPhrases = ['no findings', 'no new findings', 'found no', 'no defects'];

const contextGroups = (records: RouteRecord[]) => {
  const groups = new Map<string, RouteRecord[]>();

  for (const record of records) {
    const key = `${record.parentSession ?? ''}\u0000${record.cwd ?? ''}`;
    const group = groups.get(key) ?? [];

    group.push(record);
    groups.set(key, group);
  }

  return groups;
};

const linkedReview = (launch: RouteRecord, group: RouteRecord[], options: ComparisonOptions) => {
  const later = group.filter((record) => record.createdAt > launch.createdAt);

  const boundaries = later
    .filter((record) => record.profile === options.profile && record.predecessorId === undefined)
    .map((record) => record.createdAt);

  const boundary = boundaries.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...boundaries);

  return later
    .filter((record) => record.profile === 'reviewer' && record.createdAt < boundary)
    .reduce<RouteRecord | undefined>(
      (first, record) =>
        first === undefined || record.createdAt < first.createdAt ? record : first,
      undefined,
    );
};

const reviewMeasure = (
  launches: RouteRecord[],
  context: Map<string, RouteRecord[]>,
  options: ComparisonOptions,
) => {
  let withLinkedReview = 0;
  let withoutReport = 0;
  let withFindings = 0;

  for (const launch of launches) {
    const key = `${launch.parentSession ?? ''}\u0000${launch.cwd ?? ''}`;
    const review = linkedReview(launch, context.get(key) ?? [], options);

    if (review === undefined) {
      continue;
    }

    withLinkedReview += 1;

    if (review.outcome === undefined) {
      withoutReport += 1;

      continue;
    }

    const firstLine = (review.summary ?? '').split('\n')[0] ?? '';

    if (!noFindingsPhrases.some((phrase) => firstLine.toLowerCase().includes(phrase))) {
      withFindings += 1;
    }
  }

  const denominator = withLinkedReview - withoutReport;

  return {
    withLinkedReview,
    withoutReport,
    withFindings,
    share: denominator === 0 ? undefined : withFindings / denominator,
  };
};

const sideReport = (
  records: RouteRecord[],
  groups: Map<string, RouteRecord[]>,
  context: Map<string, RouteRecord[]>,
  options: ComparisonOptions,
  side: Side,
) => {
  const launches = records.filter(
    (record) => isCandidate(record, options) && sideOf(record, options) === side,
  );

  const modelCounts = new Map<string, number>();

  for (const launch of launches) {
    const model = launch.model ?? 'unknown';

    modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
  }

  const models = [...modelCounts]
    .map(([model, count]) => ({ model, launches: count }))
    .toSorted(
      (left, right) => right.launches - left.launches || left.model.localeCompare(right.model),
    );

  return {
    launches,
    launchCount: launches.length,
    underTwenty: launches.length < minimumSampleSize,
    models,
    firstReport: firstReportMeasure(launches),
    followUps: followUpMeasure(launches, groups),
    reviews: reviewMeasure(launches, context, options),
    success: successMeasure(launches, groups),
  };
};

export type SideReport = ReturnType<typeof sideReport>;

export const routeComparisonReport = (
  parsed: readonly ParsedRecord[],
  options: ComparisonOptions,
): RouteComparisonReport => {
  const records = parsed.flatMap((entry) => (entry.kind === 'record' ? [entry.record] : []));
  const { unique, duplicateIds } = deduplicate(records);
  const byId = new Map(unique.map((record) => [record.id, record]));
  const groups = chainGroups(unique, byId);
  const context = contextGroups(unique);

  return {
    options,
    before: sideReport(unique, groups, context, options, 'before'),
    after: sideReport(unique, groups, context, options, 'after'),
    skipped: parsed.filter((entry) => entry.kind === 'skipped').length,
    preRouting: parsed.filter((entry) => entry.kind === 'pre-routing').length,
    duplicateIds,
  };
};
