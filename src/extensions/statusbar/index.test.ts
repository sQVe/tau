import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import statusbarExtension from './index.js';

const executeFile = promisify(execFile);

type EventHandler = (event: unknown, context: ExtensionContext) => void | Promise<void>;

const setup = (cwd: string, mode = 'tui') => {
  const handlers = new Map<string, EventHandler>();
  const setFooter = vi.fn<ExtensionContext['ui']['setFooter']>();
  const context = {
    cwd,
    mode,
    ui: { setFooter },
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => undefined,
  } as unknown as ExtensionContext;

  statusbarExtension({
    on: (name: string, handler: EventHandler) => handlers.set(name, handler),
    getThinkingLevel: () => 'high',
  } as unknown as ExtensionAPI);

  const emit = async (name: string) => {
    await handlers.get(name)?.({}, context);
  };
  const mount = () => {
    const factory = setFooter.mock.calls.at(-1)?.[0];
    if (factory === undefined) {
      throw new Error('No footer factory registered');
    }

    const requestRender = vi.fn<() => void>();
    let branchChange: (() => void) | undefined;
    const unsubscribe = vi.fn<() => void>();
    const component = factory(
      { requestRender } as never,
      { fg: (_color: string, text: string) => text } as Theme,
      {
        getGitBranch: () => 'main',
        getAvailableProviderCount: () => 1,
        onBranchChange: (callback: () => void) => {
          branchChange = callback;

          return unsubscribe;
        },
        getExtensionStatuses: () => new Map([['hidden', 'HIDDEN']]),
      },
    );
    const rawRender = component.render.bind(component);
    component.render = (width) => rawRender(width).map(stripVTControlCharacters);

    return {
      rawRender,
      component,
      requestRender,
      unsubscribe,
      branchChange: () => {
        branchChange?.();
      },
    };
  };

  return { context, emit, mount, setFooter };
};

describe('statusbar extension', () => {
  it('refreshes the gate indicator from worktree state', async ({ onTestFinished }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-statusbar-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await executeFile('git', ['init', '-q'], { cwd });
    const app = setup(cwd);
    await app.emit('session_start');
    const footer = app.mount();
    onTestFinished(() => footer.component.dispose?.());
    await vi.waitFor(() => {
      expect(footer.requestRender).toHaveBeenCalled();
    });
    expect(footer.component.render(100)[0]).not.toContain('\u{F0FC6}');

    await mkdir(join(cwd, '.tau'));
    const statePath = join(cwd, '.tau/state.json');
    await writeFile(
      statePath,
      JSON.stringify({ tdd: { reds: [], gateOff: { since: '2026-05-01T00:00:00.000Z' } } }),
    );

    expect(footer.component.render(100)[0]).not.toContain('\u{F0FC6}');
    await app.emit('tool_result');

    await vi.waitFor(() => {
      expect(footer.component.render(100)[0]).toContain('main*  \u{F0FC6}');
    });

    await writeFile(statePath, JSON.stringify({ tdd: { reds: [], gateOff: null } }));
    footer.branchChange();

    await vi.waitFor(() => {
      expect(footer.component.render(100)[0]).not.toContain('\u{F0FC6}');
    });

    await writeFile(statePath, 'corrupt');
    await app.emit('tool_result');

    await vi.waitFor(() => {
      expect(footer.component.render(100)[0]).toContain('\u{F0FC6}');
    });
  });

  it('shows a persisted gate-off indicator at startup', async ({ onTestFinished }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-statusbar-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await executeFile('git', ['init', '-q'], { cwd });
    await mkdir(join(cwd, '.tau'));
    await writeFile(
      join(cwd, '.tau/state.json'),
      JSON.stringify({ tdd: { reds: [], gateOff: { since: '2026-05-01T00:00:00.000Z' } } }),
    );
    const app = setup(cwd);
    await app.emit('session_start');
    const footer = app.mount();
    onTestFinished(() => footer.component.dispose?.());

    await vi.waitFor(() => {
      expect(footer.rawRender(100)[0]).toContain('\x1b[38;2;128;96;16m\u{F0FC6}\x1b[39m');
    });
  });

  it('refreshes a replacement footer after the old footer is disposed', async ({
    onTestFinished,
  }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-statusbar-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await executeFile('git', ['init', '-q'], { cwd });
    const app = setup(cwd);
    await app.emit('session_start');
    const previous = app.mount();
    await vi.waitFor(() => {
      expect(previous.requestRender).toHaveBeenCalled();
    });
    await writeFile(join(cwd, 'file'), 'dirty');

    await app.emit('session_start');
    // Pi disposes the old component before calling the replacement factory.
    previous.component.dispose?.();
    const replacement = app.mount();

    await vi.waitFor(() => {
      expect(replacement.component.render(100)[0]).toContain('main*');
    });
    expect(previous.unsubscribe).toHaveBeenCalledOnce();
    replacement.component.dispose?.();
  });

  it('uses the Latte colors without a background', async () => {
    const app = setup('/missing/tau/abu-347');
    app.context.model = { id: 'model', reasoning: true, contextWindow: 200000 } as never;
    app.context.getContextUsage = () => ({ tokens: 46800, percent: 23.4, contextWindow: 200000 });
    await app.emit('session_start');
    const footer = app.mount();

    const line = footer.rawRender(100)[0];

    expect(line).toContain('\x1b[38;2;97;100;117mtau/abu-347\x1b[39m');
    expect(line).toContain('\x1b[38;2;32;112;104mmain\x1b[39m');
    expect(line).toContain('\x1b[38;2;30;32;40m23.4%/200k\x1b[39m');
    expect(line).toContain('\x1b[38;2;62;65;82m$0.000\x1b[39m');
    expect(line).toContain('\x1b[38;2;62;65;82mmodel\x1b[39m');
    expect(line).toContain('\x1b[38;2;124;50;168m• high\x1b[39m');
    expect(line).not.toContain('\x1b[48;');
    for (let color = 40; color <= 47; color += 1) {
      expect(line).not.toContain(`\x1b[${color}m`);
      expect(line).not.toContain(`\x1b[${color + 60}m`);
    }

    app.context.getContextUsage = () => ({ tokens: 150000, percent: 75, contextWindow: 200000 });

    expect(footer.rawRender(100)[0]).toContain('\x1b[38;2;128;96;16m75.0%/200k\x1b[39m');

    app.context.getContextUsage = () => ({ tokens: 190000, percent: 95, contextWindow: 200000 });

    expect(footer.rawRender(100)[0]).toContain('\x1b[38;2;184;37;48m95.0%/200k\x1b[39m');
    footer.component.dispose?.();
  });

  it('refreshes dirty state on tool results and branch changes outside render', async ({
    onTestFinished,
  }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-statusbar-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await executeFile('git', ['init', '-q'], { cwd });
    const app = setup(cwd);
    await app.emit('session_start');
    const footer = app.mount();
    await vi.waitFor(() => {
      expect(footer.requestRender).toHaveBeenCalled();
    });
    expect(footer.component.render(100)[0]).not.toContain('main*');

    await writeFile(join(cwd, 'file'), 'dirty');

    expect(footer.component.render(100)[0]).not.toContain('main*');

    // The handler returns before Git finishes, so the marker changes on a later render.
    await app.emit('tool_result');

    expect(footer.component.render(100)[0]).not.toContain('main*');
    await vi.waitFor(() => {
      expect(footer.component.render(100)[0]).toContain('main*');
    });

    await rm(join(cwd, 'file'));
    footer.branchChange();

    await vi.waitFor(() => {
      expect(footer.component.render(100)[0]).not.toContain('main*');
    });
    footer.component.dispose?.();
    expect(footer.unsubscribe).toHaveBeenCalledOnce();
  });

  it('marks a new file dirty at startup even when git hides untracked files', async ({
    onTestFinished,
  }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-statusbar-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await executeFile('git', ['init', '-q'], { cwd });
    await executeFile('git', ['config', 'status.showUntrackedFiles', 'no'], { cwd });
    await writeFile(join(cwd, 'file'), 'untracked');

    const app = setup(cwd);
    await app.emit('session_start');
    const footer = app.mount().component;

    expect(footer.render(100)[0]).not.toContain('main*');
    await vi.waitFor(() => {
      expect(footer.render(100)[0]).toContain('main*');
    });
    footer.dispose?.();
  });

  it('handles non-repositories', async ({ onTestFinished }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-statusbar-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const app = setup(cwd);

    await app.emit('session_start');
    const footer = app.mount();
    await vi.waitFor(() => {
      expect(footer.requestRender).toHaveBeenCalled();
    });

    expect(footer.component.render(100)[0]).not.toContain('main*');
    footer.component.dispose?.();
  });

  it.each(['rpc', 'json', 'print'])('does not install in %s mode', async (mode) => {
    const app = setup('/missing/tau/abu-347', mode);

    await app.emit('session_start');
    await app.emit('tool_result');

    expect(app.setFooter).not.toHaveBeenCalled();
  });

  it('reads all usage categories and live model context and thinking state', async () => {
    const app = setup('/missing/tau/abu-347');
    const usage = { cost: { total: 0.103 } };
    app.context.sessionManager.getEntries = () =>
      [
        { type: 'message', message: { role: 'assistant', usage } },
        { type: 'message', message: { role: 'toolResult', usage } },
        { type: 'message', message: { role: 'toolResult' } },
        { type: 'compaction', usage },
        { type: 'branch_summary', usage },
        { type: 'compaction' },
        { type: 'message', message: { role: 'user' } },
      ] as never;
    app.context.model = { id: 'model', reasoning: true, contextWindow: 200000 } as never;
    app.context.getContextUsage = () => ({ tokens: 23400, percent: 23.4, contextWindow: 100000 });

    await app.emit('session_start');
    const footer = app.mount().component;

    expect(footer.render(100)[0]).toMatch(
      /^tau\/abu-347  main +\$0.412  23.4%\/100k  model • high$/,
    );

    app.context.getContextUsage = () => undefined;
    app.context.model = { id: 'plain', reasoning: false, contextWindow: 200000 } as never;

    expect(footer.render(100)[0]).toMatch(/\?\/200k  plain$/);

    app.context.model = undefined;

    expect(footer.render(100)[0]).toMatch(/\?\/0  no-model$/);
    expect(footer.render(100)).toHaveLength(1);
    expect(app.setFooter).toHaveBeenCalledOnce();
    footer.dispose?.();
  });
});
