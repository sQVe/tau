import { homedir } from 'node:os';

import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

import { stateLabel, stateLabels } from './presentation.js';
import type { StateLabel } from './presentation.js';
import type { WorkerState } from './types.js';

// Pi renders its default result only when a tool renderer throws. This sentinel makes the fallback
// for results saved before the state field deliberate instead of an accident.
export class DefaultRenderingRequiredError extends Error {
  constructor() {
    super('This result has no renderable worker state.');
    this.name = 'DefaultRenderingRequiredError';
  }
}

interface ReportView {
  outcome?: string | undefined;
  summary?: string | undefined;
  evidence?: string[] | undefined;
}

interface StatusView {
  taskId?: string | undefined;
  name?: string | undefined;
  state: WorkerState;
  outcome?: string | undefined;
  deadline?: number | undefined;
  predecessorTaskId?: string | undefined;
  predecessorName?: string | undefined;
  successorTaskId?: string | undefined;
  report?: ReportView | undefined;
  pendingQuestion?: { questionId?: string | undefined; question?: string | undefined } | undefined;
  failure?: string | undefined;
  cleanup?: string | undefined;
  nativeState?: string | undefined;
  delivery?: string | undefined;
  observationIssue?: string | undefined;
  recovery?: { paneId?: string | undefined; directory?: string | undefined } | undefined;
  directory?: string | undefined;
  nativeSessionId?: string | undefined;
  nativeSessionFile?: string | undefined;
}

interface ReplyView {
  taskId?: string | undefined;
  name?: string | undefined;
  questionId?: string | undefined;
  delivery: string;
  workerAcknowledged?: boolean | undefined;
}

interface EvidenceView {
  taskId?: string | undefined;
  name?: string | undefined;
  evidenceError: string;
  paneId?: string | undefined;
  directory?: string | undefined;
}

interface HistoryCandidate {
  taskId?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  state?: WorkerState | undefined;
  predecessorTaskId?: string | undefined;
  successorTaskId?: string | undefined;
  nativeSessionId?: string | undefined;
  nativeSessionFile?: string | undefined;
  nativeEvidence?: string | undefined;
  report?: ReportView | undefined;
  reportFile?: string | undefined;
  truncatedFields?: string[] | undefined;
}

interface HistoryView {
  totalMatches?: number | undefined;
  nextOffset?: number | undefined;
  candidates: HistoryCandidate[];
  diagnostics?: string[] | undefined;
}

export const firstLine = (value: string | undefined): string => (value ?? '').split('\n')[0] ?? '';

export const callText = (title: string, detail: string | undefined, theme: Theme): Text => {
  const head = theme.fg('toolTitle', theme.bold(title));

  return new Text(detail ? `${head}\n${theme.fg('dim', detail)}` : head, 0, 0);
};

const historyCollapsedRows = 5;
const historyRowWidth = 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isWorkerState = (value: unknown): value is WorkerState =>
  typeof value === 'string' && Object.hasOwn(stateLabels, value);

const replyDeliveries = new Set(['sent', 'uncertain', 'notResent', 'notDelivered']);

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
};

const numberField = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];

  return typeof value === 'number' ? value : undefined;
};

const stringArrayField = (record: Record<string, unknown>, key: string): string[] | undefined => {
  const value = record[key];

  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
};

const stateField = (record: Record<string, unknown>): WorkerState | undefined =>
  isWorkerState(record.state) ? record.state : undefined;

const reportView = (value: unknown): ReportView | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    outcome: stringField(value, 'outcome'),
    summary: stringField(value, 'summary'),
    evidence: stringArrayField(value, 'evidence'),
  };
};

// oxlint-disable-next-line eslint/complexity -- One flat field mapping keeps every renderer read-only.
const statusView = (details: unknown): StatusView | undefined => {
  if (!isRecord(details)) {
    return undefined;
  }

  const state = stateField(details);

  if (state === undefined) {
    return undefined;
  }

  const pendingQuestion = isRecord(details.pendingQuestion) ? details.pendingQuestion : undefined;
  const recovery = isRecord(details.recovery) ? details.recovery : undefined;

  return {
    taskId: stringField(details, 'taskId'),
    name: stringField(details, 'name'),
    state,
    outcome: stringField(details, 'outcome'),
    deadline: numberField(details, 'deadline'),
    predecessorTaskId: stringField(details, 'predecessorTaskId'),
    predecessorName: stringField(details, 'predecessorName'),
    successorTaskId: stringField(details, 'successorTaskId'),
    report: reportView(details.report),
    pendingQuestion: pendingQuestion
      ? {
          questionId: stringField(pendingQuestion, 'questionId'),
          question: stringField(pendingQuestion, 'question'),
        }
      : undefined,
    failure: stringField(details, 'failure'),
    cleanup: stringField(details, 'cleanup'),
    nativeState: stringField(details, 'nativeState'),
    delivery: stringField(details, 'delivery'),
    observationIssue: stringField(details, 'observationIssue'),
    recovery: recovery
      ? {
          paneId: stringField(recovery, 'paneId'),
          directory: stringField(recovery, 'directory'),
        }
      : undefined,
    directory: stringField(details, 'directory'),
    nativeSessionId: stringField(details, 'nativeSessionId'),
    nativeSessionFile: stringField(details, 'nativeSessionFile'),
  };
};

const evidenceView = (details: unknown): EvidenceView | undefined => {
  if (!isRecord(details)) {
    return undefined;
  }

  const evidenceError = stringField(details, 'evidenceError');

  if (evidenceError === undefined) {
    return undefined;
  }

  const recovery = isRecord(details.recovery) ? details.recovery : undefined;

  return {
    taskId: stringField(details, 'taskId'),
    name: stringField(details, 'name'),
    evidenceError,
    paneId: recovery ? stringField(recovery, 'paneId') : undefined,
    directory: recovery ? stringField(recovery, 'directory') : undefined,
  };
};

const replyView = (details: unknown): ReplyView | undefined => {
  if (!isRecord(details)) {
    return undefined;
  }

  const delivery = stringField(details, 'delivery');

  // Results saved before delivery became a small vocabulary carry prose here. Fall back to Pi's
  // default rendering instead of labelling unknown text as an uncertain delivery.
  if (delivery === undefined || !replyDeliveries.has(delivery)) {
    return undefined;
  }

  return {
    taskId: stringField(details, 'taskId'),
    name: stringField(details, 'name'),
    questionId: stringField(details, 'questionId'),
    delivery,
    workerAcknowledged:
      typeof details.workerAcknowledged === 'boolean' ? details.workerAcknowledged : undefined,
  };
};

const historyCandidateView = (value: unknown): HistoryCandidate | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    taskId: stringField(value, 'taskId'),
    name: stringField(value, 'name'),
    description: stringField(value, 'description'),
    state: stateField(value),
    predecessorTaskId: stringField(value, 'predecessorTaskId'),
    successorTaskId: stringField(value, 'successorTaskId'),
    nativeSessionId: stringField(value, 'nativeSessionId'),
    nativeSessionFile: stringField(value, 'nativeSessionFile'),
    nativeEvidence: stringField(value, 'nativeEvidence'),
    report: reportView(value.report),
    reportFile: stringField(value, 'reportFile'),
    truncatedFields: stringArrayField(value, 'truncatedFields'),
  };
};

const historyView = (details: unknown): HistoryView | undefined => {
  if (!isRecord(details) || !Array.isArray(details.candidates)) {
    return undefined;
  }

  return {
    totalMatches: numberField(details, 'totalMatches'),
    nextOffset: numberField(details, 'nextOffset'),
    candidates: details.candidates.flatMap((entry) => {
      const candidate = historyCandidateView(entry);

      return candidate ? [candidate] : [];
    }),
    diagnostics: stringArrayField(details, 'diagnostics'),
  };
};

export const shortId = (taskId: string | undefined): string => (taskId ?? '').slice(0, 8);

const displayName = (details: { taskId?: string | undefined; name?: string | undefined }): string =>
  details.name ?? (details.taskId ? shortId(details.taskId) : 'worker');

const localClock = (deadline: number): string => {
  const date = new Date(deadline);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
};

const shortenHome = (path: string | undefined): string => {
  if (!path) {
    return 'unknown';
  }

  const home = homedir();

  return home.length > 1 && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
};

const head = (label: StateLabel, name: string, theme: Theme): string =>
  `${theme.fg(label.color, label.icon)} ${theme.bold(name)}`;

const row = (label: string, value: string, theme: Theme): string =>
  `${theme.fg('dim', `${label}:`)} ${value}`;

const joinParts = (parts: string[]): string => parts.join(' · ');

const liveStates = new Set<WorkerState>([
  'starting',
  'running',
  'awaitingReply',
  'reported',
  'stopping',
]);

const enforcedByThisSession = (state: WorkerState): boolean => liveStates.has(state);

const basePart = (details: StatusView): string => {
  const label = stateLabel(details.state, details.outcome).text;

  if (details.state === 'reported') {
    return `${label} ${details.outcome ?? details.report?.outcome ?? 'unknown outcome'}`;
  }

  if (details.state === 'cleanupUnconfirmed') {
    return `${details.outcome ?? 'cleanup'} · ${label}`;
  }

  return label;
};

// Error text often names record files or sockets. Collapsed lines never show paths; ctrl+o keeps the
// full reason.
const pathToken = /(?:~|\.{0,2})\/[^\s'"`,;)]+/g;

// A failed herdr call puts the command on the first line and the reason after it.
const reasonLine = (value: string): string => {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const reason = lines.find((line) => !/^(?:Error: )?Command failed:/.test(line));

  return reason ?? lines[0] ?? '';
};

// Parse errors quote the corrupt record; collapsed lines never show JSON.
const withoutJson = (line: string): string => {
  const brace = line.search(/[{}]/);

  return brace === -1 ? line : `${line.slice(0, brace).trimEnd()} …`;
};

const collapsedReason = (value: string): string => {
  const line = withoutJson(reasonLine(value).replaceAll(pathToken, '…')).trim();

  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
};

const assignmentDeliveryPart = (delivery: string | undefined): string[] => {
  if (delivery === 'notDelivered') {
    return ['assignment not delivered'];
  }

  if (delivery === 'uncertain') {
    return ['assignment delivery uncertain'];
  }

  return [];
};

const nativeStatePart = (details: StatusView): string[] => {
  if (!liveStates.has(details.state)) {
    return [];
  }

  if (details.nativeState === 'blocked') {
    return ['blocked on a native approval'];
  }

  if (details.nativeState !== 'unknown') {
    return [];
  }

  const reason =
    details.observationIssue === undefined ? '' : `: ${collapsedReason(details.observationIssue)}`;

  return [`native state unknown${reason}`];
};

// oxlint-disable-next-line eslint/complexity -- One ordered list keeps every conditional part together.
const statusParts = (details: StatusView): string[] => {
  const state = details.state;

  return [
    basePart(details),
    ...(details.failure ? [`failure: ${collapsedReason(details.failure)}`] : []),
    ...assignmentDeliveryPart(details.delivery),
    ...nativeStatePart(details),
    ...(state === 'reported' ? ['not stopped yet'] : []),
    ...(state === 'starting' && details.predecessorTaskId
      ? [`follows ${details.predecessorName ?? shortId(details.predecessorTaskId)}`]
      : []),
    ...(state === 'notOwned' ? ['not tracked by this session'] : []),
    ...(['starting', 'running', 'awaitingReply'].includes(state) &&
    typeof details.deadline === 'number'
      ? [`deadline ${localClock(details.deadline)}`]
      : []),
    ...(state === 'notOwned' && details.recovery?.paneId
      ? [`pane ${details.recovery.paneId}`]
      : []),
  ];
};

const statusStatement = (details: StatusView, name: string, theme: Theme): string => {
  const label = stateLabel(details.state, details.outcome);

  if (details.state === 'awaitingReply' && !details.pendingQuestion?.question) {
    return `${head(label, name, theme)} awaiting reply`;
  }

  return `${head(label, name, theme)} ${joinParts(statusParts(details))}`;
};

const collapsedSecondLine = (details: StatusView): string | undefined => {
  if (details.state === 'awaitingReply' && details.pendingQuestion?.question) {
    return firstLine(details.pendingQuestion.question);
  }

  if (details.state === 'stopped' && details.report?.summary) {
    return firstLine(details.report.summary);
  }

  if (details.state === 'cleanupUnconfirmed') {
    return details.recovery?.paneId
      ? `Check pane ${details.recovery.paneId} and stop it by hand.`
      : 'Check the pane and stop it by hand.';
  }

  return undefined;
};

export const collapsedStatusLines = (details: StatusView, theme: Theme): string[] => {
  const name = displayName(details);
  const secondLine = collapsedSecondLine(details);

  return secondLine === undefined
    ? [statusStatement(details, name, theme)]
    : [statusStatement(details, name, theme), `  ${secondLine}`];
};

const followUpHint = (details: StatusView): string => {
  if (details.state !== 'stopped') {
    return `Follow-up unavailable: the worker is ${stateLabel(details.state, details.outcome).text}.`;
  }

  if (!details.report) {
    return 'Follow-up unavailable: no report is saved.';
  }

  if (details.successorTaskId) {
    return `Follow-up unavailable: already followed up by ${details.successorTaskId}.`;
  }

  return `Follow-up available with source task ${details.taskId ?? 'unknown'}.`;
};

const deadlineRow = (details: StatusView, theme: Theme): string[] => {
  if (typeof details.deadline !== 'number') {
    return [];
  }

  const enforcement = enforcedByThisSession(details.state)
    ? 'enforced by this session'
    : 'not enforced by this session';

  return [row('Deadline', `${localClock(details.deadline)} · ${enforcement}`, theme)];
};

const identityRows = (details: StatusView, theme: Theme): string[] => [
  ...(details.outcome ? [row('Outcome', details.outcome, theme)] : []),
  ...(details.predecessorTaskId ? [row('Follows', details.predecessorTaskId, theme)] : []),
  ...(details.successorTaskId ? [row('Followed up by', details.successorTaskId, theme)] : []),
  ...(details.failure ? [row('Failure', details.failure, theme)] : []),
  ...(details.cleanup ? [row('Cleanup', details.cleanup, theme)] : []),
  ...(details.nativeState ? [row('Native state', details.nativeState, theme)] : []),
  ...(details.recovery?.paneId ? [row('Pane', details.recovery.paneId, theme)] : []),
];

const sessionRows = (details: StatusView, theme: Theme): string[] => {
  if (details.nativeSessionFile) {
    return [row('Session', shortenHome(details.nativeSessionFile), theme)];
  }

  if (details.nativeSessionId) {
    return [row('Native session ID', details.nativeSessionId, theme)];
  }

  return [];
};

export const expandedStatusLines = (details: StatusView, theme: Theme): string[] => {
  const label = stateLabel(details.state, details.outcome);
  const question = details.pendingQuestion;

  return [
    row('Task', details.taskId ?? 'unknown', theme),
    row('State', label.text, theme),
    ...(question?.questionId ? [row('Question ID', question.questionId, theme)] : []),
    ...(question?.question ? [row('Question', question.question, theme)] : []),
    ...deadlineRow(details, theme),
    ...identityRows(details, theme),
    ...(details.report?.summary ? [row('Report', details.report.summary, theme)] : []),
    ...(details.report?.evidence ?? []).map((entry) => row('Evidence', entry, theme)),
    row('Records', shortenHome(details.directory), theme),
    ...sessionRows(details, theme),
    row('Follow-up', followUpHint(details), theme),
  ];
};

const matchCount = (count: number): string => {
  if (count === 0) {
    return 'no matches';
  }

  return count === 1 ? '1 match' : `${count} matches`;
};

const historyRow = (candidate: HistoryCandidate, theme: Theme): string => {
  const name = displayName(candidate);
  const label = candidate.state
    ? stateLabel(candidate.state, candidate.report?.outcome)
    : undefined;
  const state = label
    ? `${theme.fg(label.color, label.icon)} ${label.text}`
    : theme.fg('muted', 'state unknown');
  const description = firstLine(candidate.description ?? '').slice(0, historyRowWidth);

  return `${theme.bold(name)}  ${state}  ${description}`;
};

const historyTotal = (details: HistoryView): number =>
  typeof details.totalMatches === 'number' ? details.totalMatches : details.candidates.length;

export const collapsedHistoryLines = (details: HistoryView, theme: Theme): string[] => {
  const total = historyTotal(details);
  const shown = details.candidates.slice(0, historyCollapsedRows);
  const remaining = total - shown.length;

  return [
    `${theme.fg('toolTitle', theme.bold('History'))} · ${matchCount(total)}`,
    ...shown.map((entry) => historyRow(entry, theme)),
    ...(remaining > 0 ? [theme.fg('dim', `… ${remaining} more (ctrl+o)`)] : []),
  ];
};

const candidateRows = (candidate: HistoryCandidate, theme: Theme): string[] => [
  ...(
    [
      ['Task', candidate.taskId],
      ['Name', candidate.name],
      ['State', candidate.state],
      ['Description', candidate.description],
      ['Follows', candidate.predecessorTaskId],
      ['Followed up by', candidate.successorTaskId],
      ['Report outcome', candidate.report?.outcome],
      ['Report summary', candidate.report?.summary],
      ['Native evidence', candidate.nativeEvidence],
      ['Native session ID', candidate.nativeSessionId],
      ['Native session file', candidate.nativeSessionFile],
      ['Report file', candidate.reportFile],
      ['Truncated fields', candidate.truncatedFields?.join(', ')],
    ] as [string, string | undefined][]
  )
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => row(label, value, theme)),
  ...(candidate.report?.evidence ?? []).map((entry) => row('Report evidence', entry, theme)),
];

export const expandedHistoryLines = (details: HistoryView, theme: Theme): string[] => [
  `${theme.fg('toolTitle', theme.bold('History'))} · ${matchCount(historyTotal(details))}`,
  ...details.candidates.flatMap((candidate) => [
    '',
    theme.bold(displayName(candidate)),
    ...candidateRows(candidate, theme),
  ]),
  ...(details.diagnostics ?? []).map((entry) => row('Diagnostic', entry, theme)),
];

const replyLabel = (delivery: string): StateLabel => {
  switch (delivery) {
    case 'sent':
      return { icon: '↳', color: 'accent', text: 'reply saved' };
    case 'notResent':
      return { icon: '↳', color: 'accent', text: 'reply already saved' };
    case 'notDelivered':
      return { icon: '!', color: 'error', text: 'reply not delivered' };
    default:
      return { icon: '!', color: 'warning', text: 'reply saved' };
  }
};

const replyStatement = (details: ReplyView, name: string, theme: Theme): string => {
  const label = replyLabel(details.delivery);
  const headText = `${theme.fg(label.color, label.icon)} ${theme.bold(name)}`;

  switch (details.delivery) {
    case 'sent':
      return details.workerAcknowledged
        ? `${headText} ${label.text} · sent to its pane`
        : `${headText} ${label.text} · sent to its pane · not acknowledged yet`;
    case 'notResent':
      return `${headText} ${label.text} · not resent`;
    case 'notDelivered':
      return `${headText} ${label.text} · a native dialog needs you`;
    default:
      return `${headText} ${label.text} · delivery uncertain · do not resend`;
  }
};

export const collapsedReplyLines = (details: ReplyView, theme: Theme): string[] => [
  replyStatement(details, displayName(details), theme),
];

export const expandedReplyLines = (details: ReplyView, theme: Theme): string[] => [
  row('Task', details.taskId ?? 'unknown', theme),
  ...(details.questionId ? [row('Question ID', details.questionId, theme)] : []),
  row('Delivery', details.delivery, theme),
  ...(details.workerAcknowledged === undefined
    ? []
    : [row('Acknowledged', details.workerAcknowledged ? 'yes' : 'no', theme)]),
];

export const collapsedEvidenceLines = (details: EvidenceView, theme: Theme): string[] => {
  const name = displayName(details);
  const pane = details.paneId ? `check pane ${details.paneId}` : 'check the pane';

  return [`${theme.fg('error', '!')} ${theme.bold(name)} evidence unreadable · ${pane}`];
};

export const expandedEvidenceLines = (details: EvidenceView, theme: Theme): string[] => [
  row('Task', details.taskId ?? 'unknown', theme),
  ...(details.paneId ? [row('Pane', details.paneId, theme)] : []),
  row('Evidence error', details.evidenceError, theme),
  ...(details.directory ? [row('Records', shortenHome(details.directory), theme)] : []),
];

const statusOrEvidenceLines = (
  details: unknown,
  expanded: boolean,
  theme: Theme,
): string[] | undefined => {
  const status = statusView(details);

  if (status) {
    return expanded ? expandedStatusLines(status, theme) : collapsedStatusLines(status, theme);
  }

  const evidence = evidenceView(details);

  if (evidence) {
    return expanded
      ? expandedEvidenceLines(evidence, theme)
      : collapsedEvidenceLines(evidence, theme);
  }

  return undefined;
};

export const renderStatusResult = (details: unknown, expanded: boolean, theme: Theme): Text => {
  const text = statusOrEvidenceLines(details, expanded, theme);

  if (text === undefined) {
    throw new DefaultRenderingRequiredError();
  }

  return new Text(text.join('\n'), 0, 0);
};

// Pi uses its default rendering when a message renderer returns undefined.
export const renderNotice = (
  details: unknown,
  expanded: boolean,
  theme: Theme,
): Text | undefined => {
  const text = statusOrEvidenceLines(details, expanded, theme);

  return text === undefined ? undefined : new Text(text.join('\n'), 0, 0);
};

export const renderReplyResult = (details: unknown, expanded: boolean, theme: Theme): Text => {
  const reply = replyView(details);

  if (!reply) {
    throw new DefaultRenderingRequiredError();
  }

  const text = expanded ? expandedReplyLines(reply, theme) : collapsedReplyLines(reply, theme);

  return new Text(text.join('\n'), 0, 0);
};

export const renderHistoryResult = (details: unknown, expanded: boolean, theme: Theme): Text => {
  const history = historyView(details);

  if (!history) {
    throw new DefaultRenderingRequiredError();
  }

  const text = expanded
    ? expandedHistoryLines(history, theme)
    : collapsedHistoryLines(history, theme);

  return new Text(text.join('\n'), 0, 0);
};
