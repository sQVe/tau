import type { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { stateLabel } from './presentation.js';
import type { WorkerState } from './types.js';

export interface WorkerWidgetRow {
  name: string;
  taskId: string;
  task?: string | undefined;
  label?: string | undefined;
  workerType?: string | undefined;
  state: WorkerState | 'unknown';
  deadline: number;
  createdAt: number;
  activity?: string | undefined;
  activityAt?: number | undefined;
  phaseDescription?: string | undefined;
  phaseDescriptionAt?: number | undefined;
  outcome?: string | undefined;
  terminal?: string | undefined;
  cleanup?: string | undefined;
  cleanupConfirmed?: boolean | undefined;
  stoppedAt?: number | undefined;
  details?: string | undefined;
  recovery?: string | undefined;
  detailPath?: string | undefined;
  question?: string | undefined;
  questionId?: string | undefined;
  issue?: string | undefined;
  usage: { available: false; reason: string } | { available: true; label: string };
  model?: string | undefined;
  report?: { summary: string; evidence: string[] } | undefined;
}

export const safeText = (value: string): string =>
  stripTerminalSequences(value).replace(/\p{Cc}/gu, ' ');

// Paragraph breaks are content in a full task prompt, so keep newlines and only drop other
// control characters that could move the cursor or corrupt the terminal.
export const safeMultilineText = (value: string): string =>
  stripTerminalSequences(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '  ')
    .replace(/[^\n\P{Cc}]/gu, ' ');

const duration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
};

export type WorkerGroup = 'stopped' | 'unresolved' | 'waiting' | 'active';

const unresolvedStates = new Set<WorkerWidgetRow['state']>([
  'cleanupUnconfirmed',
  'notOwned',
  'unknown',
]);

// One classification drives the compact header and the expanded groups. Precedence:
// stopped, then an unresolved state, then a real pending question, then remaining active work.
// A question retained by an unresolved record cannot change its state or add a second category.
export const workerGroup = (row: WorkerWidgetRow): WorkerGroup => {
  if (row.state === 'stopped') {
    return 'stopped';
  }

  if (unresolvedStates.has(row.state)) {
    return 'unresolved';
  }

  if (row.question !== undefined) {
    return 'waiting';
  }

  return 'active';
};

const workerRowPriority = (row: WorkerWidgetRow): number => {
  const group = workerGroup(row);

  if (group === 'stopped') {
    return 3;
  }

  if (group === 'unresolved') {
    return 0;
  }

  if (group === 'waiting') {
    return 1;
  }

  return 2;
};

const widgetDisplayPriority = (row: WorkerWidgetRow): number => {
  const priority = workerRowPriority(row);

  if (priority === 2) {
    return 0;
  }

  if (priority === 1) {
    return 1;
  }

  return 2;
};

const stateText = (row: WorkerWidgetRow): string =>
  row.state === 'unknown' ? 'status unavailable' : stateLabel(row.state, row.outcome).text;

export const truncateWorkerName = (name: string, width: number): string => {
  const suffix = name.match(/^(?:worker|investigator)-[a-z0-9]{2}$/)?.[0].slice(-3);

  if (!suffix || visibleWidth(name) <= width || width <= visibleWidth(suffix)) {
    return truncateToWidth(name, width);
  }

  const prefix = name.slice(0, -suffix.length);
  const prefixWidth = width - visibleWidth(suffix);
  const truncatedPrefix = truncateToWidth(prefix, prefixWidth, '…');

  if (visibleWidth(truncatedPrefix) > prefixWidth) {
    return `${truncateToWidth(prefix, prefixWidth - 1, '…')}${suffix}`;
  }

  return `${truncatedPrefix}${suffix}`;
};

const formatClockTime = (timestamp: number): string => {
  const date = new Date(timestamp);

  return `@${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

export const workerElapsed = (row: WorkerWidgetRow, now: number): string => {
  const clockDoesNotProveRunTime =
    row.state === 'unknown' || row.state === 'cleanupUnconfirmed' || row.state === 'notOwned';

  if (clockDoesNotProveRunTime) {
    return '--:--';
  }

  const endedAt = row.state === 'stopped' && row.cleanupConfirmed ? row.stoppedAt : undefined;

  if (row.state === 'stopped' && endedAt === undefined) {
    return '--:--';
  }

  return duration((endedAt ?? now) - row.createdAt);
};

export const compactDuration = (milliseconds: number): string => {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);

  return minutes > 0 ? `${minutes}m` : `${Math.ceil(Math.max(0, milliseconds) / 1000)}s`;
};

export const workerRightTime = (row: WorkerWidgetRow, now: number): string => {
  if (row.state === 'stopped') {
    return row.stoppedAt === undefined ? '—' : formatClockTime(row.stoppedAt);
  }

  const timerIsNotLive =
    row.state === 'unknown' || row.state === 'cleanupUnconfirmed' || row.state === 'notOwned';

  if (timerIsNotLive) {
    return row.activityAt === undefined ? '—' : formatClockTime(row.activityAt);
  }

  if (row.deadline <= now) {
    return 'overdue';
  }

  const remainingMilliseconds = row.deadline - now;
  const remainingTime =
    remainingMilliseconds < 60_000
      ? compactDuration(remainingMilliseconds)
      : `${Math.ceil(remainingMilliseconds / 60_000)}m`;

  return `${remainingTime} left`;
};

const maxTaskLabelLength = 80;

// Older records have no saved label, so derive a stable human label from the task text.
const shortTaskLabelFromText = (text: string): string => {
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstLine === undefined) {
    return '';
  }

  const withoutMarkers = firstLine.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)+/u, '').trim();
  const sentence = withoutMarkers.split(/(?<=[.!?])\s+/u)[0] ?? withoutMarkers;
  const rawLabel = sentence.length > 0 ? sentence : withoutMarkers;
  const label = safeText(rawLabel);

  return label.length > maxTaskLabelLength
    ? `${label.slice(0, maxTaskLabelLength - 1).trimEnd()}…`
    : label;
};

// The compact widget shows a parent-provided label when present, otherwise the saved task text.
export const shortTaskLabel = (row: WorkerWidgetRow): string => {
  const provided = row.label?.trim();

  if (provided !== undefined && provided.length > 0) {
    return safeText(provided);
  }

  const fallback = shortTaskLabelFromText(row.task ?? '');

  return fallback.length > 0 ? fallback : 'no task description';
};

// Show an observed model as observed, keep a requested-only value labelled, and never invent one.
export const workerModelLabel = (row: WorkerWidgetRow): string => {
  if (row.model === undefined) {
    return '—';
  }

  const parts = row.model.split(' · ');
  const observed = parts.find((part) => part.startsWith('Pi-selected '));

  if (observed) {
    return observed.slice('Pi-selected '.length);
  }

  const requested = parts.find((part) => part.startsWith('requested '));

  return requested ?? row.model;
};

const statusText = (row: WorkerWidgetRow): string => {
  if (row.state === 'running' && row.activity?.startsWith('herdr ')) {
    return safeText(row.activity);
  }

  if (workerGroup(row) === 'waiting') {
    return 'asks · waiting';
  }

  return stateText(row);
};

// Column removal and shrinking must use the same total-width calculation. The model column is
// dropped first because the full model stays reachable in the details view.
// eslint-disable-next-line eslint/complexity
const alignedColumns = (rows: WorkerWidgetRow[], availableWidth: number) => {
  // Name and status stay adjacent so the row reads as one fact. The model is last because the
  // full value stays reachable in the details view.
  const columns = [
    { name: 'name', width: Math.max(4, ...rows.map((row) => visibleWidth(row.name))) },
    { name: 'status', width: Math.max(6, ...rows.map((row) => visibleWidth(statusText(row)))) },
    { name: 'task', width: Math.max(4, ...rows.map((row) => visibleWidth(shortTaskLabel(row)))) },
    {
      name: 'model',
      width: Math.max(1, ...rows.map((row) => visibleWidth(workerModelLabel(row)))),
    },
  ];
  const totalWidth = (): number =>
    columns.reduce((sum, column) => sum + column.width, 0) + Math.max(0, columns.length - 1);

  if (totalWidth() > availableWidth) {
    const modelIndex = columns.findIndex((column) => column.name === 'model');

    if (modelIndex !== -1) {
      columns.splice(modelIndex, 1);
    }
  }

  const shrink = (name: string, floor: number): void => {
    const column = columns.find((item) => item.name === name);

    if (!column || column.width <= floor) {
      return;
    }

    column.width -= 1;
  };
  const shrinkSteps: [string, number][] = [
    ['task', 12],
    ['name', 4],
    ['status', 14],
    ['task', 1],
    ['name', 1],
    ['status', 1],
  ];

  for (const [name, floor] of shrinkSteps) {
    while (totalWidth() > availableWidth) {
      const column = columns.find((item) => item.name === name);

      if (!column || column.width <= floor) {
        break;
      }

      shrink(name, floor);
    }
  }

  while (totalWidth() > availableWidth && columns.length > 1) {
    columns.pop();
  }

  // Columns keep their natural width. The renderer pads the row to the border, so unused space
  // stays after the last column instead of opening a gap in the middle of the row.
  return columns;
};

// Keep column sizing and styling in one place so every compact row stays aligned.
const alignRow = (
  row: WorkerWidgetRow,
  rows: WorkerWidgetRow[],
  width: number,
  theme: Theme | undefined,
): string => {
  const columns = alignedColumns(rows, width);
  const label = row.state === 'unknown' ? undefined : stateLabel(row.state, row.outcome);
  const values: Record<string, string> = {
    name: truncateWorkerName(
      row.name,
      columns.find((column) => column.name === 'name')?.width ?? 4,
    ),
    status: statusText(row),
    task: shortTaskLabel(row),
    model: safeText(workerModelLabel(row)),
  };
  const cells = columns.map((column) => {
    const value = truncateToWidth(values[column.name] ?? '', column.width, '…');
    const padding = Math.max(0, column.width - visibleWidth(value));
    const padded = `${value}${' '.repeat(padding)}`;

    if (column.name === 'status' && label) {
      return theme?.fg(label.color, padded) ?? padded;
    }

    if (column.name === 'model') {
      return theme?.fg('muted', padded) ?? padded;
    }

    return padded;
  });

  return cells.join(' ');
};

const fitBorder = (
  left: string,
  right: string,
  width: number,
  theme: Theme | undefined,
): string => {
  if (width < 4) {
    return truncateToWidth('╭─', width);
  }

  const inside = width - 2;
  const fittedRight = truncateToWidth(right, inside, '…');
  const leftWidth = Math.max(0, inside - visibleWidth(fittedRight));
  const fittedLeft = truncateToWidth(left, leftWidth, '…');
  const availableFill = Math.max(0, inside - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
  const line = `${fittedLeft}${'─'.repeat(availableFill)}${fittedRight}`;

  return `${theme?.fg('border', '╭') ?? '╭'}${theme?.fg('accent', truncateToWidth(line, inside)) ?? truncateToWidth(line, inside)}${theme?.fg('border', '╮') ?? '╮'}`;
};

const boxLine = (content: string, width: number, theme: Theme | undefined): string => {
  if (width < 4) {
    return truncateToWidth('│', width);
  }

  const innerWidth = width - 4;
  const fitted = truncateToWidth(content, innerWidth, '…');
  const line = `${theme?.fg('border', '│') ?? '│'} ${fitted}${' '.repeat(Math.max(0, innerWidth - visibleWidth(fitted)))} ${theme?.fg('border', '│') ?? '│'}`;

  return line;
};

// The idle summary is one muted line instead of a box around records that can no longer change.
const mutedLine = (content: string, width: number, theme: Theme | undefined): string => {
  const fitted = truncateToWidth(content, width, '…');

  return theme?.fg('muted', fitted) ?? fitted;
};

// Border fitting is shared by the wide and narrow widget renderings.
// eslint-disable-next-line eslint/complexity
const bottomBorder = (
  left: string,
  right: string,
  width: number,
  theme: Theme | undefined,
): string => {
  if (width < 4) {
    return truncateToWidth('╰─', width);
  }

  const inside = width - 2;
  const leftContent = left ? `─ ${left}` : '─';
  const rightContent = right && width >= 32 ? ` ${right} ─` : '';

  if (left && rightContent) {
    const footer = ` ${left} · ${right} ─`;
    const fill = Math.max(0, inside - visibleWidth(footer));

    return `${theme?.fg('border', '╰') ?? '╰'}${theme?.fg('border', '─'.repeat(fill)) ?? '─'.repeat(fill)}${theme?.fg('muted', footer) ?? footer}${theme?.fg('border', '╯') ?? '╯'}`;
  }

  const fittedRight = truncateToWidth(rightContent, inside, '…');
  const leftWidth = Math.max(0, inside - visibleWidth(fittedRight));
  const fittedLeft = truncateToWidth(leftContent, leftWidth, '…');
  const fill = Math.max(0, inside - visibleWidth(fittedLeft) - visibleWidth(fittedRight));

  return [
    `${theme?.fg('border', '╰') ?? '╰'}${theme?.fg('muted', fittedLeft) ?? fittedLeft}`,
    theme?.fg('border', '─'.repeat(fill)) ?? '─'.repeat(fill),
    `${theme?.fg('muted', fittedRight) ?? fittedRight}${theme?.fg('border', '╯') ?? '╯'}`,
  ].join('');
};

export const renderWorkerWidget = (
  rows: WorkerWidgetRow[],
  width: number,
  _now: number,
  theme?: Theme,
): string[] => {
  if (width <= 0 || rows.length === 0) {
    return [];
  }

  const liveCount = rows.filter((row) => workerGroup(row) === 'active').length;
  const unknownCount = rows.filter(
    (row) => row.state === 'unknown' || row.state === 'notOwned',
  ).length;
  const cleanupCount = rows.filter((row) => row.state === 'cleanupUnconfirmed').length;
  const waitingCount = rows.filter((row) => workerGroup(row) === 'waiting').length;
  const stoppedCount = rows.filter((row) => workerGroup(row) === 'stopped').length;
  // Only work that can still change gets a row. Unresolved records from earlier processes stay in
  // history and remain visible as counts, so capacity-held records never disappear from the view.
  const eligibleRows = rows
    .filter((row) => {
      const group = workerGroup(row);

      return group === 'active' || group === 'waiting';
    })
    .toSorted(
      (left, right) =>
        workerRowPriority(left) - workerRowPriority(right) || right.createdAt - left.createdAt,
    );
  const liveRows = eligibleRows
    .slice(0, 4)
    .toSorted(
      (left, right) =>
        widgetDisplayPriority(left) - widgetDisplayPriority(right) ||
        right.createdAt - left.createdAt,
    );
  const boxWidth = width;

  if (liveRows.length === 0) {
    const summary = [
      'Subagents',
      'no active workers',
      cleanupCount > 0 ? `${cleanupCount} cleanup unconfirmed` : '',
      unknownCount > 0 ? `${unknownCount} status unknown` : '',
      stoppedCount > 0 ? `${stoppedCount} stopped` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    return [mutedLine(summary, boxWidth, theme)];
  }

  const attentionParts = (compactNames: boolean): string =>
    [
      unknownCount > 0 ? `${unknownCount} ${compactNames ? 'unknown' : 'status unknown'}` : '',
      cleanupCount > 0
        ? `${cleanupCount} ${compactNames ? 'unconfirmed' : 'cleanup unconfirmed'}`
        : '',
      waitingCount > 0 ? `${waitingCount} ${compactNames ? 'waiting' : 'waiting for reply'}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const liveLabel = (compactNames: boolean): string => {
    const attention = attentionParts(compactNames);

    return `${liveCount} live${attention ? ` · ${attention}` : ''}`;
  };
  const headerBudget = Math.max(0, boxWidth - 2 - visibleWidth('─ Subagents '));
  const shownLiveLabel =
    visibleWidth(liveLabel(false)) <= headerBudget ? liveLabel(false) : liveLabel(true);
  const lines = [fitBorder('─ Subagents ', ` ${shownLiveLabel} `, boxWidth, theme)];

  for (const row of liveRows) {
    lines.push(boxLine(alignRow(row, liveRows, boxWidth - 4, theme), boxWidth, theme));
  }

  if (eligibleRows.length > liveRows.length) {
    const overflow = eligibleRows.length - liveRows.length;

    lines.push(boxLine(`+ ${overflow} more workers`, boxWidth, theme));
  }

  const footerLeft = stoppedCount > 0 ? `${stoppedCount} stopped` : '';

  lines.push(bottomBorder(footerLeft, '', boxWidth, theme));

  return lines;
};
