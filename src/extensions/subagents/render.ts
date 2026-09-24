import { homedir } from 'node:os';
import { sep } from 'node:path';

import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

import { handoffSections, stateLabel, stateLabels } from './presentation.js';
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
  harness?: string | undefined;
  unconfirmedChildren?: string[] | undefined;
  descendantEvidence?: string | undefined;
  nativeOutput?: string | undefined;
  submission?: string | undefined;
  questionReceipt?: string | undefined;
}

interface ReplyView {
  taskId?: string | undefined;
  name?: string | undefined;
  questionId?: string | undefined;
  delivery: string;
  deliveryError?: string | undefined;
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

const childTaskIds = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ids = value.flatMap((child) => {
    const id = isRecord(child) ? stringField(child, 'taskId') : undefined;

    return id === undefined ? [] : [id];
  });

  return ids.length > 0 ? ids : undefined;
};

// Requested receipts are summarized into one row each; ctrl+o is where the pilot reads them.
const submissionSummary = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const intent = isRecord(value.intent) ? value.intent : {};
  const observation = isRecord(value.observation) ? value.observation : {};
  const parts = [
    stringField(intent, 'id'),
    stringField(observation, 'state') ?? 'no observation',
    stringField(observation, 'detail'),
  ];

  return parts.filter((part): part is string => part !== undefined).join(' · ');
};

const questionReceiptSummary = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const question = isRecord(value.question) ? value.question : {};
  const id = stringField(question, 'questionId') ?? 'unknown question';
  const saved =
    value.reply === undefined || value.reply === null ? 'no reply saved' : 'reply saved';
  const acknowledged = isRecord(value.acknowledgement) ? 'acknowledged' : 'not acknowledged yet';

  return `${id} · ${saved} · ${acknowledged}`;
};

const nativeOutputText = (value: unknown): string | undefined =>
  isRecord(value) ? stringField(value, 'text') : undefined;

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
    harness: stringField(details, 'harness'),
    unconfirmedChildren: childTaskIds(details.unconfirmedChildren),
    descendantEvidence: stringField(details, 'descendantEvidence'),
    nativeOutput: nativeOutputText(details.nativeOutput),
    submission: submissionSummary(details.submissionReceipt),
    questionReceipt: questionReceiptSummary(details.questionReceipt),
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
    deliveryError: stringField(details, 'deliveryError'),
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

  const insideHome = path === home || path.startsWith(`${home}${sep}`);

  return home.length > 1 && insideHome ? `~${path.slice(home.length)}` : path;
};

const head = (label: StateLabel, name: string, theme: Theme): string =>
  `${theme.fg(label.color, label.icon)} ${theme.bold(name)}`;

const row = (label: string, value: string, theme: Theme): string =>
  `${theme.fg('dim', `${label}:`)} ${value}`;

const optionalRow = (label: string, value: string | undefined, theme: Theme): string[] => {
  if (value === undefined || value === '') {
    return [];
  }

  return [row(label, value, theme)];
};

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

// Raw failure and observation text is unbounded and can quote paths, JSON, or commands. Collapsed
// lines flag it with a fixed phrase; ctrl+o shows the full text.
const reasonHint = 'ctrl+o for the reason';

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

  return ['native state unknown'];
};

// A child whose cleanup is unconfirmed may still run and holds capacity, whatever the parent's state.
const childParts = (details: StatusView): string[] => {
  const children = details.unconfirmedChildren ?? [];

  return children.length > 0
    ? [`child ${children.map((id) => shortId(id)).join(', ')} cleanup unconfirmed`]
    : [];
};

const deadlineStates = new Set<WorkerState>(['starting', 'running', 'awaitingReply']);

const lifecycleParts = (details: StatusView, state: WorkerState): string[] => {
  const parts: string[] = [];

  if (state === 'reported') {
    parts.push('not stopped yet');
  }

  if (state === 'starting' && details.predecessorTaskId) {
    parts.push(`follows ${details.predecessorName ?? shortId(details.predecessorTaskId)}`);
  }

  if (state === 'notOwned') {
    parts.push('not tracked by this session');
  }

  if (deadlineStates.has(state) && typeof details.deadline === 'number') {
    parts.push(`deadline ${localClock(details.deadline)}`);
  }

  if (state === 'notOwned' && details.recovery?.paneId) {
    parts.push(`pane ${details.recovery.paneId}`);
  }

  return parts;
};

// One hint covers every reason the collapsed line leaves to ctrl+o.
const hasHiddenReason = (details: StatusView): boolean => {
  const observed = nativeStatePart(details).length > 0 && details.observationIssue !== undefined;

  return Boolean(details.failure) || observed;
};

const statusParts = (details: StatusView): string[] => {
  const parts = [basePart(details)];

  if (details.failure) {
    parts.push('failed');
  }

  parts.push(
    ...assignmentDeliveryPart(details.delivery),
    ...nativeStatePart(details),
    ...lifecycleParts(details, details.state),
    ...childParts(details),
  );

  if (hasHiddenReason(details)) {
    parts.push(reasonHint);
  }

  return parts;
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

  if (details.harness !== 'pi') {
    return 'Follow-up unavailable: only Pi workers can continue; start a fresh task instead.';
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
  ...optionalRow('Outcome', details.outcome, theme),
  ...optionalRow('Follows', details.predecessorTaskId, theme),
  ...optionalRow('Followed up by', details.successorTaskId, theme),
  ...optionalRow('Failure', details.failure, theme),
  ...optionalRow('Observation', details.observationIssue, theme),
  ...optionalRow('Cleanup', details.cleanup, theme),
  ...optionalRow('Native state', details.nativeState, theme),
  ...optionalRow('Pane', details.recovery?.paneId, theme),
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

const missingHandoffRows = (report: ReportView | undefined, theme: Theme): string[] => {
  const missing = handoffSections(report)?.missing ?? [];

  return missing.length ? [row('Handoff sections missing', missing.join(', '), theme)] : [];
};

const requestedRows = (details: StatusView, theme: Theme): string[] => [
  ...(details.unconfirmedChildren ?? []).map((id) => row('Child cleanup unconfirmed', id, theme)),
  ...optionalRow('Descendants', details.descendantEvidence, theme),
  ...optionalRow('Question receipt', details.questionReceipt, theme),
  ...optionalRow('Submission', details.submission, theme),
  ...optionalRow('Native output', details.nativeOutput, theme),
];

export const expandedStatusLines = (details: StatusView, theme: Theme): string[] => {
  const label = stateLabel(details.state, details.outcome);
  const question = details.pendingQuestion;

  return [
    row('Task', details.taskId ?? 'unknown', theme),
    row('State', label.text, theme),
    ...optionalRow('Question ID', question?.questionId, theme),
    ...optionalRow('Question', question?.question, theme),
    ...deadlineRow(details, theme),
    ...identityRows(details, theme),
    ...optionalRow('Report', details.report?.summary, theme),
    ...(details.report?.evidence ?? []).map((entry) => row('Evidence', entry, theme)),
    ...missingHandoffRows(details.report, theme),
    row('Records', shortenHome(details.directory), theme),
    ...sessionRows(details, theme),
    ...requestedRows(details, theme),
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
  const hidden = details.candidates.length - shown.length;
  const lines = [
    `${theme.fg('toolTitle', theme.bold('History'))} · ${matchCount(total)}`,
    ...shown.map((entry) => historyRow(entry, theme)),
  ];

  if (hidden > 0) {
    lines.push(theme.fg('dim', `… ${hidden} more (ctrl+o)`));
  }

  if (details.nextOffset !== undefined) {
    lines.push(theme.fg('dim', 'More matches on the next page'));
  }

  return lines;
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

export const expandedHistoryLines = (details: HistoryView, theme: Theme): string[] => {
  const lines = [
    `${theme.fg('toolTitle', theme.bold('History'))} · ${matchCount(historyTotal(details))}`,
    ...details.candidates.flatMap((candidate) => [
      '',
      theme.bold(displayName(candidate)),
      ...candidateRows(candidate, theme),
    ]),
    ...(details.diagnostics ?? []).map((entry) => row('Diagnostic', entry, theme)),
  ];

  if (details.nextOffset !== undefined) {
    const instruction = `Repeat the same query with nextOffset: ${details.nextOffset}.`;

    lines.push(row('Next page', instruction, theme));
  }

  return lines;
};

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

const acknowledgedText = (acknowledged: boolean | undefined): string | undefined => {
  if (acknowledged === undefined) {
    return undefined;
  }

  return acknowledged ? 'yes' : 'no';
};

const expandedReplyLines = (details: ReplyView, theme: Theme): string[] => [
  row('Task', details.taskId ?? 'unknown', theme),
  ...optionalRow('Question ID', details.questionId, theme),
  row('Delivery', details.delivery, theme),
  ...optionalRow('Delivery error', details.deliveryError, theme),
  ...optionalRow('Acknowledged', acknowledgedText(details.workerAcknowledged), theme),
];

const collapsedEvidenceLines = (details: EvidenceView, theme: Theme): string[] => {
  const name = displayName(details);
  const pane = details.paneId ? `check pane ${details.paneId}` : 'check the pane';

  return [`${theme.fg('error', '!')} ${theme.bold(name)} evidence unreadable · ${pane}`];
};

const expandedEvidenceLines = (details: EvidenceView, theme: Theme): string[] => {
  const directory = details.directory ? shortenHome(details.directory) : undefined;

  return [
    row('Task', details.taskId ?? 'unknown', theme),
    ...optionalRow('Pane', details.paneId, theme),
    row('Evidence error', details.evidenceError, theme),
    ...optionalRow('Records', directory, theme),
  ];
};

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
