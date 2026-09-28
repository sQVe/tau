// Replaces tmux.ts surface placement from pi-interactive-subagents c3e8b53.
import {
  listTerminals,
  requireObject,
  resolveTerminal,
  result,
  terminalLocation,
  text,
} from './terminal.js';
import type { TerminalCall, TerminalLocation } from './terminal.js';

export type Visibility = 'foreground' | 'background';

// The reason explains a foreground request that landed in the background.
export type Placement = TerminalLocation & { visibility: Visibility; reason?: string };

interface PlacementInput {
  name: string;
  // Renames the tab without the launch budget, so a hung rename cannot fail the launch.
  labelCall?: TerminalCall;
  parentPane?: string;
  visibility: Visibility;
  cwd: string;
  environment: Record<string, string>;
  // Runs as the pane's own process instead of the user's shell.
  command?: string[];
  // Receives the pane ID as soon as herdr starts the command, before its terminal is known.
  onLaunched?: (paneId: string) => void;
  onCreated?: (location: TerminalLocation) => void;
}

interface TabSearch {
  tabs: string[];
  parent: TerminalLocation;
  locations: TerminalLocation[];
  call: TerminalCall;
}

type PaneLayout = Record<string, unknown> & { panes: unknown[] };

interface Rectangle {
  width: number;
  height: number;
}

// Leave room for pane borders and status rows around 80 columns and 20 useful rows.
const minimumPane = { width: 82, height: 24 };

const isPositiveInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) > 0;

const rectangle = (value: unknown): Rectangle => {
  const bounds = requireObject(value);

  if (!isPositiveInteger(bounds.width) || !isPositiveInteger(bounds.height)) {
    throw new Error('Invalid herdr pane dimensions.');
  }

  return { width: Number(bounds.width), height: Number(bounds.height) };
};

const isUseful = (bounds: Rectangle): boolean =>
  bounds.width >= minimumPane.width && bounds.height >= minimumPane.height;

// The one foreground worker goes beside its parent. Background workers split along the axis that
// fits more useful panes, so a worker tab holds more of them.
const preferRight = (bounds: Rectangle, down: boolean, beside: boolean): boolean =>
  !down || beside || bounds.width / minimumPane.width >= bounds.height / minimumPane.height;

export const splitDirection = (bounds: Rectangle, beside = false): 'right' | 'down' | undefined => {
  // Herdr rounds the first half up and gives the second half the remaining cells.
  const right = isUseful({ width: Math.floor(bounds.width / 2), height: bounds.height });
  const down = isUseful({ width: bounds.width, height: Math.floor(bounds.height / 2) });

  if (right && preferRight(bounds, down, beside)) {
    return 'right';
  }

  return down ? 'down' : undefined;
};

const readLayout = async (paneId: string, call: TerminalCall): Promise<PaneLayout> => {
  const layout = requireObject(result(await call(['pane', 'layout', '--pane', paneId])).layout);

  if (typeof layout.zoomed !== 'boolean') {
    throw new TypeError('Missing herdr zoom state.');
  }

  if (!Array.isArray(layout.panes)) {
    throw new TypeError('Missing herdr layout panes.');
  }

  return { ...layout, panes: layout.panes };
};

const layoutShape = (layout: PaneLayout): string => {
  return JSON.stringify({
    workspace: layout.workspace_id,
    tab: layout.tab_id,
    area: layout.area,
    zoomed: layout.zoomed,
    splits: layout.splits,
    panes: layout.panes.map((value) => {
      const pane = requireObject(value);

      return { paneId: text(pane.pane_id), rectangle: pane.rect };
    }),
  });
};

const splitCandidate = (
  layout: PaneLayout,
  eligible: TerminalLocation[],
  workspaceId: string,
  tabId: string,
  visibility: Visibility,
) => {
  if (layout.tab_id !== tabId || layout.workspace_id !== workspaceId) {
    throw new Error('Placement target moved; no layout changes.');
  }

  if (layout.zoomed === true) {
    return undefined;
  }

  const candidates = layout.panes
    .flatMap((value) => {
      const pane = requireObject(value);
      const bounds = rectangle(pane.rect);
      const direction = splitDirection(bounds, visibility === 'foreground');
      const location = eligible.find((entry) => entry.paneId === text(pane.pane_id));

      return direction && location ? [{ location, bounds, direction }] : [];
    })
    .toSorted(
      (left, right) =>
        right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height,
    );

  return candidates[0];
};

export class WorkerPlacement {
  private readonly owned = new Map<string, { tabId: string; visibility: Visibility }>();
  // Workers in each background tab's label, in launch order. Unlike owned, a cancelled placement
  // keeps its name until the stop path releases it.
  private readonly labelled = new Map<string, { tabId: string; name: string }>();
  // Release stops splitting a worker pane, but a pane that cleanup left open still shows.
  private foreground: string | undefined;
  private pending: Promise<unknown> = Promise.resolve();

  // Only the stop path passes a call; that is when the name leaves the tab label.
  release(terminalId: string, call?: TerminalCall): void {
    this.owned.delete(terminalId);
    const labelled = this.labelled.get(terminalId);

    if (call && labelled) {
      this.labelled.delete(terminalId);
      this.pending = this.pending.then(() => this.relabel(labelled.tabId, call));
    }
  }

  private label(tabId: string): string {
    const names = [...this.labelled.values()]
      .filter((worker) => worker.tabId === tabId)
      .map((worker) => worker.name);

    const shown = names.slice(0, 3).join(', ');

    return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
  }

  // The tab label is cosmetic; a failed rename never fails a launch or a stop.
  private async relabel(tabId: string, call: TerminalCall): Promise<void> {
    const label = this.label(tabId);

    if (label === '') {
      return;
    }

    try {
      await call(['tab', 'rename', tabId, label]);
    } catch {
      // Keep the previous label.
    }
  }

  private async enqueue<Result>(
    operation: () => Promise<Result>,
    signal: AbortSignal,
  ): Promise<Result> {
    signal.throwIfAborted();

    // Serialize owned topology changes, not worker startup. Waiting retains each task's original budget.
    const pending = this.pending.then(() => {
      signal.throwIfAborted();

      return operation();
    });

    this.pending = pending.catch(() => undefined);
    const cancelled = Promise.withResolvers<never>();

    const abort = () => {
      cancelled.reject(new Error('Worker placement cancelled or its budget expired.'));
    };

    signal.addEventListener('abort', abort, { once: true });

    try {
      return await Promise.race([pending, cancelled.promise]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async close(
    close: () => Promise<void>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    await this.enqueue(close, signal);
  }

  async place(
    input: PlacementInput,
    call: TerminalCall,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Placement> {
    let location: TerminalLocation | undefined;

    const onCreated = (created: TerminalLocation) => {
      location = created;
      // Deliver confirmed identity before cancellation can release placement ownership.
      input.onCreated?.(created);

      if (signal.aborted) {
        this.release(created.terminalId);
        signal.throwIfAborted();
      }
    };

    const checkedCall: TerminalCall = (argumentsList) => {
      signal.throwIfAborted();

      return call(argumentsList);
    };

    try {
      return await this.enqueue(() => this.create({ ...input, onCreated }, checkedCall), signal);
    } finally {
      if (location && signal.aborted) {
        this.release(location.terminalId);
      }
    }
  }

  private ownsBackgroundTab(pane: TerminalLocation, parent: TerminalLocation): boolean {
    const owned = this.owned.get(pane.terminalId);
    const ownedBackground = owned?.visibility === 'background' && owned.tabId === pane.tabId;

    return (
      pane.workspaceId === parent.workspaceId && pane.tabId !== parent.tabId && ownedBackground
    );
  }

  private isEligiblePane(
    pane: TerminalLocation,
    parent: TerminalLocation,
    tabId: string,
    visibility: Visibility,
  ): boolean {
    if (pane.terminalId === parent.terminalId) {
      return true;
    }

    const owned = this.owned.get(pane.terminalId);

    return owned?.tabId === tabId && owned.visibility === visibility;
  }

  private async confirmTarget(
    target: TerminalLocation,
    shape: ReturnType<typeof layoutShape>,
    call: TerminalCall,
  ): Promise<void> {
    const current = await listTerminals(call);

    const present = current.some(
      (pane) =>
        pane.terminalId === target.terminalId &&
        pane.paneId === target.paneId &&
        pane.tabId === target.tabId,
    );

    if (!present) {
      throw new Error('Placement target moved or closed; no layout changes.');
    }

    const latest = await readLayout(target.paneId, call);

    if (layoutShape(latest) !== shape) {
      throw new Error('Layout changed during placement; no layout changes.');
    }
  }

  // Choose the pane to split, and check that its tab still matches the layout read.
  private async target(eligible: TerminalLocation[], visibility: Visibility, call: TerminalCall) {
    const first = eligible[0];

    if (!first) {
      return undefined;
    }

    const layout = await readLayout(first.paneId, call);
    const shape = layoutShape(layout);
    const candidate = splitCandidate(layout, eligible, first.workspaceId, first.tabId, visibility);

    if (!candidate) {
      return undefined;
    }

    // External moves, closes, and resizing do not share our queue. Abandon changed plans; never replay a saved layout.
    await this.confirmTarget(candidate.location, shape, call);

    return { ...candidate, visibility };
  }

  private async findTarget(search: TabSearch) {
    const { tabs, parent, locations, call } = search;

    for (const tabId of tabs) {
      const visibility = tabId === parent.tabId ? 'foreground' : 'background';
      const panes = locations.filter((pane) => pane.tabId === tabId);
      const eligible = panes.filter((pane) => this.isEligiblePane(pane, parent, tabId, visibility));

      if (visibility === 'background' && eligible.length !== panes.length) {
        continue;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- Search owned tabs until one has room.
      const target = await this.target(eligible, visibility, call);

      if (target) {
        return target;
      }
    }

    return undefined;
  }

  // Every worker starts in a new tab. A command runs as the pane's own process, without a shell.
  private async createTab(
    parent: TerminalLocation,
    input: PlacementInput,
    call: TerminalCall,
  ): Promise<TerminalLocation> {
    const currentParent = await resolveTerminal(parent.terminalId, call);

    if (
      currentParent.paneId !== parent.paneId ||
      currentParent.workspaceId !== parent.workspaceId
    ) {
      throw new Error('Parent moved during placement; no layout changes.');
    }

    const parentLayout = requireObject(
      result(await call(['pane', 'layout', '--pane', currentParent.paneId])).layout,
    );

    if (!isUseful(rectangle(parentLayout.area))) {
      throw new Error(
        'Terminal area is too small for a useful worker tab. Enlarge it before launching.',
      );
    }

    const location = input.command
      ? await this.applyCommandTab(parent, { ...input, command: input.command }, call)
      : terminalLocation(
          result(
            await call([
              'tab',
              'create',
              '--workspace',
              parent.workspaceId,
              '--label',
              input.name,
              '--cwd',
              input.cwd,
              '--no-focus',
              ...Object.entries(input.environment).flatMap(([key, value]) => [
                '--env',
                `${key}=${value}`,
              ]),
            ]),
          ).root_pane,
        );

    this.owned.set(location.terminalId, { tabId: location.tabId, visibility: 'background' });
    this.labelled.set(location.terminalId, { tabId: location.tabId, name: input.name });
    input.onCreated?.(location);

    return location;
  }

  private async applyCommandTab(
    parent: TerminalLocation,
    input: PlacementInput & { command: string[] },
    call: TerminalCall,
  ): Promise<TerminalLocation> {
    // Never pass tab_id: herdr would replace that tab.
    const applied = await call([
      'layout',
      'apply',
      JSON.stringify({
        workspace_id: parent.workspaceId,
        tab_label: input.name,
        focus: false,
        root: { type: 'pane', cwd: input.cwd, env: input.environment, command: input.command },
      }),
    ]);

    const paneId = text(requireObject(requireObject(result(applied).layout).root).pane_id);

    input.onLaunched?.(paneId);

    return terminalLocation(result(await call(['pane', 'get', paneId])).pane);
  }

  private async create(input: PlacementInput, call: TerminalCall): Promise<Placement> {
    const paneTarget =
      input.parentPane != null && input.parentPane !== ''
        ? ['--pane', input.parentPane]
        : ['--current'];

    const parent = terminalLocation(result(await call(['pane', 'current', ...paneTarget])).pane);
    const locations = await listTerminals(call);

    if (
      !locations.some(
        (pane) => pane.paneId === parent.paneId && pane.terminalId === parent.terminalId,
      )
    ) {
      throw new Error('Parent terminal moved during placement; no layout changes.');
    }

    const backgroundTabs = locations
      .filter((pane) => this.ownsBackgroundTab(pane, parent))
      .map((pane) => pane.tabId);

    const candidateTabs = [...backgroundTabs];

    // One worker pane beside the parent is readable; more split the tab into panes nobody reads.
    const showing = locations.some(
      (pane) => pane.terminalId === this.foreground && pane.tabId === parent.tabId,
    );

    if (input.visibility === 'foreground' && !showing) {
      candidateTabs.unshift(parent.tabId);
    }

    const tabs = [...new Set(candidateTabs)];
    const target = await this.findTarget({ tabs, parent, locations, call });
    const created = await this.createTab(parent, input, call);
    let location = created;

    if (target) {
      const moved = await call([
        'pane',
        'move',
        created.paneId,
        '--tab',
        target.location.tabId,
        '--target-pane',
        target.location.paneId,
        '--split',
        target.direction,
        '--no-focus',
      ]);

      location = terminalLocation(requireObject(result(moved).move_result).pane);
      this.owned.set(location.terminalId, { tabId: location.tabId, visibility: target.visibility });

      if (target.visibility === 'foreground') {
        this.foreground = location.terminalId;
        this.labelled.delete(location.terminalId);
      } else {
        this.labelled.set(location.terminalId, { tabId: location.tabId, name: input.name });
        await this.relabel(location.tabId, input.labelCall ?? call);
      }
    }

    if (location.tabId === parent.tabId) {
      return { ...location, visibility: 'foreground' };
    }

    if (input.visibility === 'background') {
      return { ...location, visibility: 'background' };
    }

    const reason = showing
      ? 'Another worker is already visible beside the parent.'
      : 'The parent tab is zoomed or too small for another pane.';

    return { ...location, visibility: 'background', reason };
  }
}
