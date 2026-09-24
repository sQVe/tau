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

import { stateLabel } from './presentation.js';
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

  if (row.activity?.startsWith('herdr ') && row.state === 'running') {
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

const groupPriority = (row: WorkerWidgetRow): number => {
  const group = rowGroup(row);

  if (group === 'STATUS UNKNOWN') {
    return 0;
  }

  if (group === 'CLEANUP UNCONFIRMED') {
    return 1;
  }

  if (group === 'WAITING FOR REPLY') {
    return 2;
  }

  if (group === 'LIVE') {
    return 3;
  }

  return 4;
};

const sortedHistory = (rows: WorkerWidgetRow[]): WorkerWidgetRow[] =>
  rows.toSorted((left, right) => {
    const groupDifference = groupPriority(left) - groupPriority(right);

    return groupDifference || right.createdAt - left.createdAt;
  });

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

// Keep per-column truncation and alignment together for each history row. The task label sits
// next to the state, the elapsed column is gone because the right time already answers the same
// question, and the model is the first column to go when the list is too narrow.
// eslint-disable-next-line eslint/complexity
const renderHistoryRow = (
  row: WorkerWidgetRow,
  allRows: WorkerWidgetRow[],
  width: number,
  selected: boolean,
  now: number,
  theme: Theme,
): string => {
  const markerWidth = 1;
  const glyphWidth = 1;
  const timeWidth = Math.min(
    16,
    Math.max(6, ...allRows.map((item) => visibleWidth(historyTime(item, now)))),
  );
  const nameWidth = Math.max(4, ...allRows.map((item) => visibleWidth(item.name)));
  const stateWidth = Math.max(8, ...allRows.map((item) => visibleWidth(rowState(item))));
  const labelWidth = Math.max(4, ...allRows.map((item) => visibleWidth(shortTaskLabel(item))));
  const modelWidth = Math.max(1, ...allRows.map((item) => visibleWidth(workerModelLabel(item))));
  const innerWidth = Math.max(0, width - 4);
  let showModel = true;
  let shownNameWidth = nameWidth;
  let shownStateWidth = stateWidth;
  let shownLabelWidth = labelWidth;
  let shownTimeWidth = timeWidth;
  const gaps = (): number => (showModel ? 6 : 5);
  const used = (): number =>
    markerWidth +
    glyphWidth +
    shownNameWidth +
    shownStateWidth +
    shownLabelWidth +
    (showModel ? modelWidth : 0) +
    shownTimeWidth +
    gaps();

  if (used() > innerWidth) {
    showModel = false;
  }

  while (used() > innerWidth && shownStateWidth > 8) {
    shownStateWidth -= 1;
  }

  while (used() > innerWidth && shownNameWidth > 4) {
    shownNameWidth -= 1;
  }

  while (used() > innerWidth && shownLabelWidth > 4) {
    shownLabelWidth -= 1;
  }

  while (used() > innerWidth && shownStateWidth > 1) {
    shownStateWidth -= 1;
  }

  while (used() > innerWidth && shownLabelWidth > 1) {
    shownLabelWidth -= 1;
  }

  while (used() > innerWidth && shownTimeWidth > 1) {
    shownTimeWidth -= 1;
  }

  const spareWidth = Math.max(0, innerWidth - used());
  shownLabelWidth += spareWidth;

  const label = row.state === 'unknown' ? undefined : stateLabel(row.state, row.outcome);
  const fields = [
    selected ? '▶' : ' ',
    label?.icon ?? '?',
    truncateName(row, shownNameWidth),
    shownStateWidth > 0 ? truncateToWidth(safeText(rowState(row)), shownStateWidth, '…') : '',
    shownLabelWidth > 0 ? truncateToWidth(shortTaskLabel(row), shownLabelWidth, '…') : '',
    ...(showModel ? [truncateToWidth(safeText(workerModelLabel(row)), modelWidth, '…')] : []),
    historyTime(row, now),
  ];
  const widths = [
    markerWidth,
    glyphWidth,
    shownNameWidth,
    shownStateWidth,
    shownLabelWidth,
    ...(showModel ? [modelWidth] : []),
    shownTimeWidth,
  ];
  const cells = fields.map((field, index) => {
    const fieldWidth = widths[index] ?? 0;
    const fitted = truncateToWidth(field, fieldWidth, '…');
    const padding = Math.max(0, fieldWidth - visibleWidth(fitted));
    const text =
      index === fields.length - 1
        ? `${' '.repeat(padding)}${fitted}`
        : `${fitted}${' '.repeat(padding)}`;

    if (index === 1 && label) {
      return theme.fg(label.color, text);
    }

    if (!selected) {
      return text;
    }

    if (index === 0) {
      return theme.fg('accent', theme.bold(text));
    }

    return index === 2 ? theme.bold(text) : text;
  });
  const content = cells.join(' ');

  return content;
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
  const labelWidth = Math.max(7, ...fields.map(([name]) => visibleWidth(name)));
  const contentWidth = Math.max(1, width - 4 - labelWidth - 2);
  const lines: string[] = [];

  for (const [name, rawValue] of fields) {
    const wrapped = wrapDetailValue(rawValue, contentWidth);

    wrapped.forEach((line, index) => {
      const fieldLabel = index === 0 ? name : '';
      const content = `${fieldLabel.padEnd(labelWidth)}  ${line}`;

      lines.push(truncateToWidth(content, width - 4, '…'));
    });
  }

  return lines;
};

// The full task prompt stays in its own on-demand section so it cannot bury the key facts.
const promptLines = (row: WorkerWidgetRow, width: number): string[] => {
  const labelWidth = Math.max(7, visibleWidth('Full prompt'));
  const contentWidth = Math.max(1, width - 4 - labelWidth - 2);
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

  return lines.map((line) => truncateToWidth(line, width - 4, '…'));
};

// Key facts come first so a long task prompt never buries the state, model, or recovery fields.
// eslint-disable-next-line eslint/complexity
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

  const deadline =
    row.deadline <= now ? 'deadline passed' : `${compactDuration(row.deadline - now)} left`;
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

  if (row.report?.evidence.length) {
    fields.push(['Evidence', row.report.evidence.join(' · ')]);
  }

  if (row.report) {
    fields.push(['Decisions', 'not recorded separately in the saved report']);
    fields.push(['Concerns', 'not recorded separately in the saved report']);
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

  if (row.model !== undefined) {
    const modelParts = row.model.split(' · ');
    const requested = modelParts.find((part) => part.startsWith('requested '));
    const observed = modelParts.find(
      (part) => part.startsWith('observed ') || part.startsWith('Pi-selected '),
    );

    if (requested && observed) {
      fields.push(['Model', requested]);
      const observedValue = observed.startsWith('Pi-selected ')
        ? `observed Pi-selected ${observed.slice('Pi-selected '.length)}`
        : observed;

      fields.push(['', observedValue]);
    } else {
      fields.push(['Model', row.model]);
    }
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
    const selectedIndex = selectedTaskId
      ? filteredRows.findIndex((row) => row.taskId === selectedTaskId)
      : -1;

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

  // eslint-disable-next-line eslint/complexity
  private handleDetailInput(data: string): void {
    const halfPage = Math.max(1, Math.floor(this.viewportHeight / 2));

    if (matchesKey(data, 'ctrl+d')) {
      this.detailOffset += halfPage;
    } else if (matchesKey(data, 'ctrl+u')) {
      this.detailOffset = Math.max(0, this.detailOffset - halfPage);
    } else if (this.keybindings.matches(data, 'tui.select.up') || data === 'k') {
      this.detailOffset = Math.max(0, this.detailOffset - 1);
    } else if (this.keybindings.matches(data, 'tui.select.down') || data === 'j') {
      this.detailOffset += 1;
    } else if (data === 'g') {
      this.detailOffset = 0;
    } else if (data === 'G') {
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
    } else if (this.keybindings.matches(data, 'tui.select.up') || data === 'k') {
      this.moveSelection(-1);
    } else if (this.keybindings.matches(data, 'tui.select.down') || data === 'j') {
      this.moveSelection(1);
    } else if (
      this.keybindings.matches(data, 'tui.select.confirm') &&
      this.filteredRows()[this.selectedIndex]
    ) {
      this.detail = true;
      this.detailOffset = 0;
      this.showFullPrompt = false;
    } else if (data === 'g') {
      this.selectedIndex = 0;
    } else if (data === 'G') {
      this.selectedIndex = Math.max(0, this.filteredRows().length - 1);
    }
  }

  invalidate(): void {
    this.filterInput.invalidate();
  }

  // Keep rendering phases together so selection, list geometry, and modal boundaries stay in sync.
  // eslint-disable-next-line eslint/complexity
  render(width: number): string[] {
    const boxWidth = width;
    const innerWidth = Math.max(1, boxWidth - 4);
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
    const visibleHeight = Math.max(2, Math.min(22, this.tui.terminal.rows - 7));
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

        addedLines.push(renderHistoryRow(row, rows, width + 4, row === selected, now, this.theme));

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
    const inside = Math.max(0, width - 4);
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

    return `${this.theme.fg('border', left)}${this.theme.fg('accent', fittedTitle)}${this.theme.fg('border', '─'.repeat(fill))}${this.theme.fg('muted', fittedRight)}${this.theme.fg('border', corner)}`;
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
