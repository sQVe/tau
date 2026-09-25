import {
  ForegroundShares,
  isUseful,
  layoutShape,
  rectangle,
  splitDirection,
} from './foreground.js';
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

const splitCandidate = (
  layout: Record<string, unknown>,
  eligible: TerminalLocation[],
  workspaceId: string,
  tabId: string,
) => {
  if (layout.tab_id !== tabId || layout.workspace_id !== workspaceId) {
    throw new Error('Placement target moved; no layout changes.');
  }

  if (!Array.isArray(layout.panes)) {
    throw new TypeError('Missing herdr layout panes.');
  }

  if (layout.zoomed === true) {
    return undefined;
  }

  const candidates = layout.panes
    .flatMap((value) => {
      const pane = requireObject(value);
      const bounds = rectangle(pane.rect);
      const direction = splitDirection(bounds);
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
  private readonly foreground = new ForegroundShares();

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
    location: TerminalLocation,
    call: TerminalCall,
    close: () => Promise<void>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const readLayout: TerminalCall = async (argumentsList) => {
      signal.throwIfAborted();
      const response = await call(argumentsList);

      signal.throwIfAborted();

      return response;
    };

    await this.enqueue(
      () =>
        this.foreground.close(location, readLayout, async () => {
          signal.throwIfAborted();
          await close();
        }),
      signal,
    );
  }

  async place(
    input: PlacementInput,
    call: TerminalCall,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TerminalLocation> {
    let location: TerminalLocation | undefined;

    const onCreated = (created: TerminalLocation) => {
      location = created;
      // Deliver confirmed identity synchronously, before any cosmetic snapshot can yield or abort.
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

    const latest = requireObject(
      result(await call(['pane', 'layout', '--pane', target.paneId])).layout,
    );

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

    let layout = requireObject(
      result(await call(['pane', 'layout', '--pane', first.paneId])).layout,
    );

    const plan = visibility === 'foreground' ? this.foreground.plan(layout, eligible) : undefined;

    if (plan) {
      layout = await this.foreground.balance(plan, layout, eligible, call);
    }

    const shape = layoutShape(layout);
    const candidates = plan ? eligible.filter((pane) => pane.paneId === plan.target) : eligible;
    const candidate = splitCandidate(layout, candidates, first.workspaceId, first.tabId);

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
      '--ratio',
      '0.5',
      ...options,
    ]);

    const location = terminalLocation(result(created).pane);

    this.owned.set(location.terminalId, { tabId: location.tabId, visibility });
    onCreated?.(location);

    if (visibility === 'foreground') {
      await this.foreground.remember({
        before: layout,
        target: target.paneId,
        added: location,
        direction: candidate.direction,
        call,
        tree: plan?.tree,
        isOwned: () => this.owned.has(location.terminalId),
      });
    }

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
