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

interface PlacementInput {
  parentPane?: string;
  visibility: Visibility;
  cwd: string;
  environment: string[];
  onCreated?: (location: TerminalLocation) => void;
}

interface SplitRequest {
  eligible: TerminalLocation[];
  visibility: Visibility;
  options: string[];
  call: TerminalCall;
  onCreated: PlacementInput['onCreated'];
}

interface TabSearch {
  tabs: string[];
  parent: TerminalLocation;
  locations: TerminalLocation[];
  options: string[];
  call: TerminalCall;
  onCreated: PlacementInput['onCreated'];
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

// A parent alone in its foreground tab slightly favors a worker beside it, but only when a worker
// below it could not keep a useful third of the height. Where it can, stacking first lets later
// workers share the tab.
const preferRight = (bounds: Rectangle, down: boolean, alone: boolean): boolean => {
  const columns = bounds.width / minimumPane.width;
  const rows = bounds.height / minimumPane.height;
  const short = bounds.height - Math.round((bounds.height * 2) / 3) < minimumPane.height;

  return !down || (alone && short ? 1.1 : 1) * columns >= rows;
};

export const splitDirection = (bounds: Rectangle, alone = false): 'right' | 'down' | undefined => {
  // Herdr rounds the first half up and gives the second half the remaining cells.
  const right = isUseful({ width: Math.floor(bounds.width / 2), height: bounds.height });
  const down = isUseful({ width: bounds.width, height: Math.floor(bounds.height / 2) });

  if (right && preferRight(bounds, down, alone)) {
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

  const alone = visibility === 'foreground' && layout.panes.length === 1;

  const candidates = layout.panes
    .flatMap((value) => {
      const pane = requireObject(value);
      const bounds = rectangle(pane.rect);
      const direction = splitDirection(bounds, alone);
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
  private pending: Promise<unknown> = Promise.resolve();

  release(terminalId: string): void {
    this.owned.delete(terminalId);
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
  ): Promise<TerminalLocation> {
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

  private async split(request: SplitRequest): Promise<TerminalLocation | undefined> {
    const { eligible, visibility, options, call, onCreated } = request;
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
    const target = candidate.location;

    await this.confirmTarget(target, shape, call);

    const created = await call([
      'pane',
      'split',
      '--pane',
      target.paneId,
      '--direction',
      candidate.direction,
      ...options,
    ]);

    const location = terminalLocation(result(created).pane);

    this.owned.set(location.terminalId, { tabId: location.tabId, visibility });
    onCreated?.(location);

    return location;
  }

  private async placeInTabs(search: TabSearch): Promise<TerminalLocation | undefined> {
    const { tabs, parent, locations, options, call, onCreated } = search;

    for (const tabId of tabs) {
      const visibility = tabId === parent.tabId ? 'foreground' : 'background';
      const panes = locations.filter((pane) => pane.tabId === tabId);
      const eligible = panes.filter((pane) => this.isEligiblePane(pane, parent, tabId, visibility));

      if (visibility === 'background' && eligible.length !== panes.length) {
        continue;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- Search owned tabs until a single placement succeeds.
      const location = await this.split({ eligible, visibility, options, call, onCreated });

      if (location) {
        return location;
      }
    }

    return undefined;
  }

  private async createBackgroundTab(
    parent: TerminalLocation,
    options: string[],
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

    const area = rectangle(parentLayout.area);

    if (!isUseful(area)) {
      throw new Error(
        'Terminal area is too small for a useful worker tab. Enlarge it before launching.',
      );
    }

    const location = terminalLocation(
      result(
        await call([
          'tab',
          'create',
          '--workspace',
          parent.workspaceId,
          '--label',
          'Tau workers',
          ...options,
        ]),
      ).root_pane,
    );

    this.owned.set(location.terminalId, { tabId: location.tabId, visibility: 'background' });

    return location;
  }

  private async create(input: PlacementInput, call: TerminalCall): Promise<TerminalLocation> {
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

    if (input.visibility === 'foreground') {
      candidateTabs.unshift(parent.tabId);
    }

    const tabs = [...new Set(candidateTabs)];
    const environment = input.environment.flatMap((value) => ['--env', value]);
    const options = ['--cwd', input.cwd, '--no-focus', ...environment];

    const placed = await this.placeInTabs({
      tabs,
      parent,
      locations,
      options,
      call,
      onCreated: input.onCreated,
    });

    if (placed) {
      return placed;
    }

    const location = await this.createBackgroundTab(parent, options, call);

    input.onCreated?.(location);

    return location;
  }
}
