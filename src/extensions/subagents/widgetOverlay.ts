import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';

import { boxFrameWidth } from '../../box.js';
import { isBottom, isDown, isTop, isUp } from '../../keys.js';
import { stateLabel } from './presentation.js';
import { deadlineStates } from './render.js';
import type { WorkerWidgetRow } from './widget.js';
import {
  compactDuration,
  safeMultilineText,
  safeText,
  shortTaskLabel,
  truncateWorkerName,
  workerElapsed,
  workerGroup,
  workerModelLabel,
  workerRightTime,
} from './widget.js';

interface HistoryColumn {
  name: 'marker' | 'glyph' | 'name' | 'state' | 'label' | 'model' | 'time';
  width: number;
}

const rowGroup = (
  row: WorkerWidgetRow,
): 'CLEANUP UNCONFIRMED' | 'STATUS UNKNOWN' | 'WAITING FOR REPLY' | 'LIVE' | 'STOPPED' => {
  const group = workerGroup(row);

  if (group === 'stopped') {
    return 'STOPPED';
  }

  if (group === 'unresolved') {
    return row.state === 'cleanupUnconfirmed' ? 'CLEANUP UNCONFIRMED' : 'STATUS UNKNOWN';
  }

  if (group === 'waiting') {
    return 'WAITING FOR REPLY';
  }

  return 'LIVE';
};

const rowState = (row: WorkerWidgetRow): string => {
  if (workerGroup(row) === 'waiting') {
    return 'asks · waiting';
  }

  const label =
    row.state === 'unknown' ? 'status unavailable' : stateLabel(row.state, row.outcome).text;

  if (row.activity?.startsWith('herdr ') === true && row.state === 'running') {
    return safeText(row.activity);
  }

  if (row.activity !== undefined && row.state === 'running') {
    return `${label} · ${safeText(row.activity)}`;
  }

  return label;
};

const rowSearchText = (row: WorkerWidgetRow): string =>
  [
    row.name,
    row.taskId,
    shortTaskLabel(row),
    row.task,
    row.state,
    row.question,
    row.issue,
    row.report?.summary,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ')
    .toLocaleLowerCase();

const groupPriorities: Record<ReturnType<typeof rowGroup>, number> = {
  'STATUS UNKNOWN': 0,
  'CLEANUP UNCONFIRMED': 1,
  'WAITING FOR REPLY': 2,
  LIVE: 3,
  STOPPED: 4,
};

const groupPriority = (row: WorkerWidgetRow): number => groupPriorities[rowGroup(row)];

const sortedHistory = (rows: WorkerWidgetRow[]): WorkerWidgetRow[] =>
  rows.toSorted((left, right) => {
    const groupDifference = groupPriority(left) - groupPriority(right);

    return groupDifference || right.createdAt - left.createdAt;
  });

// Columns shrink to these widths before any column goes lower.
const historyColumnWidths = { time: 6, name: 4, state: 8, label: 4 };
const maximumTimeWidth = 16;
const minimumDetailLabelWidth = 7;
const maximumBodyRows = 22;
// Terminal rows kept outside the overlay body.
const overlayChromeRows = 7;

const truncateName = (row: WorkerWidgetRow, width: number): string =>
  truncateWorkerName(row.name, width);

const localTime = (timestamp: number): string => {
  const date = new Date(timestamp);

  return `@${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const historyTime = (row: WorkerWidgetRow, now: number): string => {
  if (row.state === 'stopped') {
    return row.stoppedAt === undefined ? '—' : localTime(row.stoppedAt);
  }

  if (row.state === 'cleanupUnconfirmed' || row.state === 'notOwned' || row.state === 'unknown') {
    return row.activityAt === undefined ? '—' : localTime(row.activityAt);
  }

  if (workerGroup(row) === 'waiting') {
    return row.activityAt === undefined ? 'asks' : compactDuration(now - row.activityAt);
  }

  return workerRightTime(row, now);
};

const historyColumns = (rows: WorkerWidgetRow[], width: number, now: number): HistoryColumn[] => {
  const name: HistoryColumn = {
    name: 'name',
    width: Math.max(historyColumnWidths.name, ...rows.map((row) => visibleWidth(row.name))),
  };

  const state: HistoryColumn = {
    name: 'state',
    width: Math.max(historyColumnWidths.state, ...rows.map((row) => visibleWidth(rowState(row)))),
  };

  const label: HistoryColumn = {
    name: 'label',
    width: Math.max(
      historyColumnWidths.label,
      ...rows.map((row) => visibleWidth(shortTaskLabel(row))),
    ),
  };

  const model: HistoryColumn = {
    name: 'model',
    width: Math.max(1, ...rows.map((row) => visibleWidth(workerModelLabel(row)))),
  };

  const time: HistoryColumn = {
    name: 'time',
    width: Math.min(
      maximumTimeWidth,
      Math.max(historyColumnWidths.time, ...rows.map((row) => visibleWidth(historyTime(row, now)))),
    ),
  };

  const columns: HistoryColumn[] = [
    { name: 'marker', width: 1 },
    { name: 'glyph', width: 1 },
    name,
    state,
    label,
    model,
    time,
  ];

  const used = (): number =>
    columns.reduce((sum, column) => sum + column.width, 0) + columns.length - 1;

  if (used() > width) {
    columns.splice(columns.indexOf(model), 1);
  }

  const shrinkSteps: [HistoryColumn, number][] = [
    [state, historyColumnWidths.state],
    [name, historyColumnWidths.name],
    [label, historyColumnWidths.label],
    [state, 1],
    [label, 1],
    [time, 1],
  ];

  for (const [column, minimum] of shrinkSteps) {
    while (used() > width && column.width > minimum) {
      column.width -= 1;
    }
  }

  label.width += Math.max(0, width - used());

  return columns;
};

const historyCellValue = (
  row: WorkerWidgetRow,
  column: HistoryColumn,
  values: Record<HistoryColumn['name'], string>,
): string => {
  if (column.name === 'name') {
    return truncateName(row, column.width);
  }

  const value = values[column.name];

  const needsFitting =
    column.name === 'state' || column.name === 'label' || column.name === 'model';

  return needsFitting ? truncateToWidth(value, column.width, '…') : value;
};

const renderHistoryRow = (
  row: WorkerWidgetRow,
  columns: HistoryColumn[],
  selected: boolean,
  now: number,
  theme: Theme,
): string => {
  const label = row.state === 'unknown' ? undefined : stateLabel(row.state, row.outcome);

  const values: Record<HistoryColumn['name'], string> = {
    marker: selected ? '▶' : ' ',
    glyph: label?.icon ?? '?',
    name: row.name,
    state: safeText(rowState(row)),
    label: shortTaskLabel(row),
    model: safeText(workerModelLabel(row)),
    time: historyTime(row, now),
  };

  const cells = columns.map((column) => {
    const field = historyCellValue(row, column, values);
    const fitted = truncateToWidth(field, column.width, '…');
    const padding = Math.max(0, column.width - visibleWidth(fitted));

    const text =
      column.name === 'time'
        ? `${' '.repeat(padding)}${fitted}`
        : `${fitted}${' '.repeat(padding)}`;

    if (column.name === 'glyph' && label) {
      return theme.fg(label.color, text);
    }

    if (!selected) {
      return text;
    }

    if (column.name === 'marker') {
      return theme.fg('accent', theme.bold(text));
    }

    return column.name === 'name' ? theme.bold(text) : text;
  });

  return cells.join(' ');
};

const wrapDetailValue = (value: string, contentWidth: number): string[] => {
  const lines: string[] = [];

  for (const paragraph of safeMultilineText(value).split('\n')) {
    if (paragraph.trim().length === 0) {
      lines.push('');

      continue;
    }

    lines.push(...wrapTextWithAnsi(paragraph, contentWidth));
  }

  return lines.length > 0 ? lines : [''];
};

const formatDetailFields = (fields: [string, string][], width: number): string[] => {
  const labelWidth = Math.max(
    minimumDetailLabelWidth,
    ...fields.map(([name]) => visibleWidth(name)),
  );

  const contentWidth = Math.max(1, width - boxFrameWidth - labelWidth - 2);
  const lines: string[] = [];

  for (const [name, rawValue] of fields) {
    const wrapped = wrapDetailValue(rawValue, contentWidth);

    wrapped.forEach((line, index) => {
      const fieldLabel = index === 0 ? name : '';
      const content = `${fieldLabel.padEnd(labelWidth)}  ${line}`;

      lines.push(truncateToWidth(content, width - boxFrameWidth, '…'));
    });
  }

  return lines;
};

// The full task prompt stays in its own on-demand section so it cannot bury the key facts.
const promptLines = (row: WorkerWidgetRow, width: number): string[] => {
  const labelWidth = Math.max(minimumDetailLabelWidth, visibleWidth('Full prompt'));
  const contentWidth = Math.max(1, width - boxFrameWidth - labelWidth - 2);
  const indent = ' '.repeat(labelWidth + 2);
  const paragraphs = safeMultilineText(row.task ?? '(task text not recorded)').split('\n');
  const lines = ['', 'Full task prompt'];

  for (const paragraph of paragraphs) {
    if (paragraph.trim().length === 0) {
      lines.push('');

      continue;
    }

    for (const wrapped of wrapTextWithAnsi(paragraph, contentWidth)) {
      lines.push(`${indent}${wrapped}`);
    }
  }

  return lines.map((line) => truncateToWidth(line, width - boxFrameWidth, '…'));
};

// Key facts come first so a long task prompt never buries the state, model, or recovery fields.
// eslint-disable-next-line eslint/complexity -- Each optional report field adds one branch in display order.
const reportLines = (row: WorkerWidgetRow, width: number): string[] => {
  const fields: [string, string][] = [];
  const now = Date.now();

  const label =
    row.state === 'unknown' ? 'status unavailable' : stateLabel(row.state, row.outcome).text;

  const elapsed = workerElapsed(row, now);
  const elapsedMinutes = Number.parseInt(elapsed.split(':')[0] ?? '0', 10);
  let runtime = 'run time unknown';

  if (elapsed !== '--:--') {
    runtime = row.state === 'stopped' ? `ran ${elapsedMinutes}m` : `elapsed ${elapsedMinutes}m`;
  }

  const deadlineIsLive = row.state !== 'unknown' && deadlineStates.has(row.state);
  let deadline = 'deadline passed';

  if (row.deadline > now) {
    deadline = deadlineIsLive
      ? `${compactDuration(row.deadline - now)} left`
      : `deadline ${localTime(row.deadline)}`;
  }

  const timing = `started ${localTime(row.createdAt).slice(1)} · ${runtime} · ${deadline}`;

  fields.push(['Task name', shortTaskLabel(row)]);
  fields.push(['State', label]);
  fields.push(['Worker', `${row.name} · ${row.workerType ?? 'worker'}`]);

  if (row.question !== undefined) {
    fields.push(['Question', row.question]);
  }

  if (row.questionId !== undefined) {
    fields.push(['Question ID', row.questionId]);
  }

  if (row.phaseDescription !== undefined) {
    fields.push(['Progress', row.phaseDescription]);

    fields.push([
      'Updated',
      row.phaseDescriptionAt === undefined
        ? 'update time not recorded'
        : localTime(row.phaseDescriptionAt),
    ]);
  }

  if (row.issue !== undefined) {
    fields.push(['Blocker', row.issue]);
  }

  if (row.outcome !== undefined) {
    fields.push(['Outcome', row.outcome]);
  }

  if (row.report?.summary !== undefined) {
    fields.push(['Report', row.report.summary]);
  }

  if (row.report != null && row.report.evidence.length > 0) {
    fields.push(['Evidence', row.report.evidence.join(' · ')]);
  }

  if (row.terminal !== undefined) {
    fields.push(['Observed', row.terminal]);
  }

  if (row.cleanup !== undefined) {
    fields.push(['Cleanup', row.cleanup]);
  }

  if (row.details !== undefined) {
    fields.push(['Safety', row.details]);
  }

  if (row.recovery !== undefined) {
    fields.push(['Recovery', row.recovery]);
  }

  if (row.requestedModel !== undefined) {
    fields.push(['Model', `requested ${row.requestedModel}`]);

    const observed =
      row.observedModel === undefined
        ? 'observed unavailable'
        : `observed Pi-selected ${row.observedModel}`;

    fields.push(['', observed]);
  } else if (row.observedModel !== undefined) {
    fields.push(['Model', `Pi-selected ${row.observedModel}`]);
  }

  fields.push([
    'Usage',
    row.usage.available ? row.usage.label : `unavailable · ${row.usage.reason}`,
  ]);

  fields.push(['Cost', 'not estimated · catalog cost is not subscription allowance']);
  fields.push(['Time', timing]);
  fields.push(['Task ID', row.taskId]);

  if (row.detailPath !== undefined) {
    fields.push(['File', row.detailPath]);
  }

  return formatDetailFields(fields, width);
};

const detailSections = (
  row: WorkerWidgetRow,
  width: number,
): { facts: string[]; prompt: string[] } => ({
  facts: reportLines(row, width),
  prompt: promptLines(row, width),
});

export class WorkerHistoryView implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private rows: WorkerWidgetRow[];
  private readonly done: (name?: string) => void;
  private readonly filterInput = new Input({ prompt: '/ ' });
  private selectedIndex = 0;
  private detail = false;
  private filterMode = false;
  private detailOffset = 0;
  private visibleRange: [number, number] = [0, 0];
  private showFullPrompt = false;
  private viewportHeight = 10;
  private lastWidth = 80;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    rows: WorkerWidgetRow[],
    done: (name?: string) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.rows = sortedHistory(rows);
    this.done = done;
  }

  setRows(rows: WorkerWidgetRow[]): void {
    const selectedTaskId = this.filteredRows()[this.selectedIndex]?.taskId;
    const previousIndex = this.selectedIndex;

    this.rows = sortedHistory(rows);
    const filteredRows = this.filteredRows();

    const selectedIndex =
      selectedTaskId != null ? filteredRows.findIndex((row) => row.taskId === selectedTaskId) : -1;

    this.selectedIndex =
      selectedIndex >= 0
        ? selectedIndex
        : Math.min(previousIndex, Math.max(0, filteredRows.length - 1));

    const nextSelectedTaskId = filteredRows[this.selectedIndex]?.taskId;

    if (nextSelectedTaskId !== selectedTaskId) {
      this.detailOffset = 0;
      this.showFullPrompt = false;
    }

    this.tui.requestRender();
  }

  dismiss(): void {
    this.close();
  }

  private filteredRows(): WorkerWidgetRow[] {
    const query = this.filterInput.getValue().trim().toLocaleLowerCase();

    return query ? this.rows.filter((row) => rowSearchText(row).includes(query)) : this.rows;
  }

  private close(): void {
    this.done();
  }

  private selectIndex(index: number): void {
    this.selectedIndex = index;
    this.detailOffset = 0;
    this.showFullPrompt = false;
  }

  // Arrows and j/k keep their wrapping policy.
  private moveSelection(direction: number): void {
    const rows = this.filteredRows();

    if (rows.length === 0) {
      return;
    }

    this.selectIndex((this.selectedIndex + direction + rows.length) % rows.length);
  }

  // Page keys clamp at the ends so a half-page move never wraps or hides the selection.
  private moveSelectionClamped(offset: number): void {
    const rows = this.filteredRows();

    if (rows.length === 0) {
      return;
    }

    const target = Math.min(rows.length - 1, Math.max(0, this.selectedIndex + offset));

    this.selectIndex(target);
  }

  handleInput(data: string): void {
    if (this.filterMode) {
      this.handleFilterInput(data);

      return;
    }

    if (this.keybindings.matches(data, 'tui.select.cancel')) {
      if (this.detail) {
        this.detail = false;
        this.detailOffset = 0;
        this.showFullPrompt = false;
      } else {
        this.close();
      }

      this.tui.requestRender();

      return;
    }

    if (this.detail) {
      this.handleDetailInput(data);

      return;
    }

    this.handleListInput(data);
    this.tui.requestRender();
  }

  private handleFilterInput(data: string): void {
    if (this.keybindings.matches(data, 'tui.select.confirm')) {
      this.filterMode = false;
      this.tui.requestRender();

      return;
    }

    if (this.keybindings.matches(data, 'tui.select.cancel')) {
      this.filterInput.setValue('');
      this.filterMode = false;
      this.tui.requestRender();

      return;
    }

    this.filterInput.handleInput(data);
    this.selectedIndex = 0;
    this.tui.requestRender();
  }

  // eslint-disable-next-line eslint/complexity -- Each key binding is one branch of the same dispatch.
  private handleDetailInput(data: string): void {
    const halfPage = Math.max(1, Math.floor(this.viewportHeight / 2));

    if (matchesKey(data, 'ctrl+d')) {
      this.detailOffset += halfPage;
    } else if (matchesKey(data, 'ctrl+u')) {
      this.detailOffset = Math.max(0, this.detailOffset - halfPage);
    } else if (this.keybindings.matches(data, 'tui.select.up') || isUp(data)) {
      this.detailOffset = Math.max(0, this.detailOffset - 1);
    } else if (this.keybindings.matches(data, 'tui.select.down') || isDown(data)) {
      this.detailOffset += 1;
    } else if (isTop(data)) {
      this.detailOffset = 0;
    } else if (isBottom(data)) {
      this.detailOffset = Number.MAX_SAFE_INTEGER;
    } else if (data === 'p') {
      this.showFullPrompt = !this.showFullPrompt;

      if (this.showFullPrompt) {
        const row = this.filteredRows()[this.selectedIndex];

        if (row) {
          this.detailOffset = detailSections(row, this.lastWidth).facts.length;
        }
      }
    } else if (data === '[') {
      this.moveSelection(-1);
    } else if (data === ']') {
      this.moveSelection(1);
    } else if (data === 'i') {
      const row = this.filteredRows()[this.selectedIndex];

      if (row) {
        // The editor restores its saved text when this view closes, so return the name and let the
        // caller paste it after the close resolves.
        this.done(row.name);
      } else {
        this.close();
      }
    }

    this.tui.requestRender();
  }

  private handleListInput(data: string): void {
    const halfPage = Math.max(1, Math.floor(this.viewportHeight / 2));

    if (matchesKey(data, 'ctrl+d')) {
      this.moveSelectionClamped(halfPage);
    } else if (matchesKey(data, 'ctrl+u')) {
      this.moveSelectionClamped(-halfPage);
    } else if (data === '/') {
      this.filterMode = true;
      this.filterInput.focused = true;
    } else if (this.keybindings.matches(data, 'tui.select.up') || isUp(data)) {
      this.moveSelection(-1);
    } else if (this.keybindings.matches(data, 'tui.select.down') || isDown(data)) {
      this.moveSelection(1);
    } else if (
      this.keybindings.matches(data, 'tui.select.confirm') &&
      this.filteredRows()[this.selectedIndex]
    ) {
      this.detail = true;
      this.detailOffset = 0;
      this.showFullPrompt = false;
    } else if (isTop(data)) {
      this.selectedIndex = 0;
    } else if (isBottom(data)) {
      this.selectedIndex = Math.max(0, this.filteredRows().length - 1);
    }
  }

  invalidate(): void {
    this.filterInput.invalidate();
  }

  // eslint-disable-next-line eslint/complexity -- Selection, list geometry, and modal bounds render together to stay in sync.
  render(width: number): string[] {
    const boxWidth = width;
    const innerWidth = Math.max(1, boxWidth - boxFrameWidth);
    const rows = this.filteredRows();
    const selected = rows[this.selectedIndex];

    const title =
      this.detail && selected
        ? `${selected.name} · ${selected.workerType ?? 'worker'}`
        : `Subagents · ${rows.length} workers`;

    const topRight =
      this.detail && selected ? ` ${this.detailPosition(rows.length)} ─` : ' / to filter ─';

    const topLine = this.roundBorder('╭', `─ ${title} `, topRight, '╮', boxWidth);

    const footer = this.detail
      ? '↑↓ ctrl+d/u scroll · p prompt · [ ] · i · esc'
      : '↑↓ j/k move · enter open · / filter · esc close';

    const visibleHeight = Math.max(
      2,
      Math.min(maximumBodyRows, this.tui.terminal.rows - overlayChromeRows),
    );

    const bodyHeight = visibleHeight - Number(!this.detail && this.filterMode);

    this.viewportHeight = bodyHeight;
    this.lastWidth = width;

    const body =
      this.detail && selected
        ? this.renderDetails(selected, boxWidth)
        : this.renderRows(rows, selected, innerWidth, bodyHeight);

    const detailMaxOffset = Math.max(0, body.length - bodyHeight);

    this.detailOffset = Math.min(this.detailOffset, detailMaxOffset);

    const viewport = this.detail
      ? body.slice(this.detailOffset, this.detailOffset + bodyHeight)
      : body;

    const page =
      rows.length === 0
        ? '0/0'
        : `${this.visibleRange[0] + 1}–${this.visibleRange[1]}/${rows.length}`;

    const lines = [topLine];

    if (!this.detail && this.filterMode) {
      lines.push(this.boxLine(`Filter ${this.filterInput.render(innerWidth).join('')}`, boxWidth));
    }

    for (const line of viewport) {
      lines.push(this.boxLine(line, boxWidth));
    }

    lines.push(
      this.roundBorder('╰', `─ ${footer} `, this.detail ? '─' : ` ${page} ─`, '╯', boxWidth),
    );

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderRows(
    rows: WorkerWidgetRow[],
    selected: WorkerWidgetRow | undefined,
    width: number,
    visibleHeight: number,
  ): string[] {
    if (rows.length === 0) {
      const query = this.filterInput.getValue().trim();
      const message = query ? `No workers match "${safeText(query)}".` : 'No worker records yet.';

      return [this.theme.fg('muted', message)];
    }

    const selectedIndex = selected === undefined ? 0 : Math.max(0, rows.indexOf(selected));
    const now = Date.now();
    const columns = historyColumns(rows, width, now);
    let start = Math.max(0, selectedIndex - visibleHeight + 1);
    let end = start;
    let rendered: string[] = [];

    while (start <= selectedIndex) {
      end = start;
      rendered = [];
      let priorGroup: ReturnType<typeof rowGroup> | undefined;

      while (end < rows.length) {
        const row = rows[end];

        if (!row) {
          break;
        }

        const group = rowGroup(row);
        const addedLines: string[] = [];

        if (group !== priorGroup) {
          addedLines.push(this.theme.fg('muted', group));
        }

        addedLines.push(renderHistoryRow(row, columns, row === selected, now, this.theme));

        if (rendered.length + addedLines.length > visibleHeight) {
          break;
        }

        rendered.push(...addedLines);
        priorGroup = group;
        end += 1;
      }

      if (selectedIndex < end || end === rows.length) {
        break;
      }

      start += 1;
    }

    this.visibleRange = [start, end];

    return rendered;
  }

  private detailPosition(rowCount: number): string {
    return `${this.selectedIndex + 1} of ${rowCount}`;
  }

  private renderDetails(row: WorkerWidgetRow, width: number): string[] {
    const sections = detailSections(row, width);

    return this.showFullPrompt ? [...sections.facts, ...sections.prompt] : sections.facts;
  }

  private boxLine(content: string, width: number): string {
    const inside = Math.max(0, width - boxFrameWidth);
    const fitted = truncateToWidth(content, inside, '…');
    const padding = Math.max(0, inside - visibleWidth(fitted));

    return `${this.theme.fg('border', '│')} ${fitted}${' '.repeat(padding)} ${this.theme.fg('border', '│')}`;
  }

  private roundBorder(
    left: string,
    title: string,
    right: string,
    corner: string,
    width: number,
  ): string {
    if (width <= 0) {
      return '';
    }

    const inside = Math.max(0, width - visibleWidth(left) - visibleWidth(corner));
    const fittedRight = truncateToWidth(right, inside, '…');
    const titleWidth = Math.max(0, inside - visibleWidth(fittedRight));
    const fittedTitle = truncateToWidth(title, titleWidth, '…');

    const fill = Math.max(
      0,
      width -
        visibleWidth(left) -
        visibleWidth(fittedTitle) -
        visibleWidth(fittedRight) -
        visibleWidth(corner),
    );

    return [
      `${this.theme.fg('border', left)}${this.theme.fg('accent', fittedTitle)}`,
      this.theme.fg('border', '─'.repeat(fill)),
      `${this.theme.fg('muted', fittedRight)}${this.theme.fg('border', corner)}`,
    ].join('');
  }
}

export const openWorkerHistory = async (
  context: ExtensionCommandContext,
  rows: WorkerWidgetRow[],
  onView: (view: WorkerHistoryView) => void,
): Promise<void> => {
  // A non-overlay custom component replaces the editor area: the view stays in the bottom region
  // above the transcript, keeps keyboard focus, and restores the editor and its text on close.
  const selectedName = await context.ui.custom<string | undefined>(
    (tui, overlayTheme, overlayKeybindings, done) => {
      const view = new WorkerHistoryView(tui, overlayTheme, overlayKeybindings, rows, done);

      onView(view);

      return view;
    },
  );

  // Paste only after the custom UI closes and restores the saved editor text, or the restore would
  // erase the insertion.
  if (selectedName !== undefined) {
    context.ui.pasteToEditor(selectedName);
  }
};
