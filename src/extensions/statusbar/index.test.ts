import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import statusbarExtension from './index.js';

const git = promisify(execFile);
const setup = (cwd: string, mode = 'tui') => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const setFooter = vi.fn<ExtensionContext['ui']['setFooter']>();
  const ctx = {
    cwd,
    mode,
    ui: { setFooter },
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => undefined,
  } as unknown as ExtensionContext;
  statusbarExtension({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
      handlers.set(name, handler),
    getThinkingLevel: () => 'high',
  } as unknown as ExtensionAPI);
  const emit = async (name: string) => {
    await handlers.get(name)?.({}, ctx);
  };
  const mount = () => {
    const factory = setFooter.mock.calls[0]?.[0];
    expect(factory).toBeTypeOf('function');
    const requestRender = vi.fn<() => void>();
    let branchChange = () => {};
    const unsubscribe = vi.fn<() => void>();
    const component = factory!(
      { requestRender } as never,
      { fg: (_color: string, text: string) => text } as Theme,
      {
        getGitBranch: () => 'main',
        onBranchChange: (callback: () => void) => {
          branchChange = callback;
          return unsubscribe;
        },
        getExtensionStatuses: () => new Map([['hidden', 'HIDDEN']]),
      } as never,
    );
    const rawRender = component.render.bind(component);
    component.render = (width) => rawRender(width).map(stripVTControlCharacters);
    return {
      rawRender,
      component,
      requestRender,
      unsubscribe,
      branchChange: () => {
        branchChange();
      },
    };
  };
  return { ctx, emit, mount, setFooter, handlers };
};

describe('statusbar extension', () => {
  it('uses the approved Latte colors without a background', async () => {
    const app = setup('/missing/tau/abu-347');
    app.ctx.model = { id: 'model', reasoning: true, contextWindow: 200000 } as never;
    app.ctx.getContextUsage = () => ({ percent: 23.4, contextWindow: 200000 }) as never;
    await app.emit('session_start');
    const footer = app.mount();
    const line = footer.rawRender(100)[0];
    expect(line).toContain('\x1b[38;2;97;100;117mtau/abu-347\x1b[39m');
    expect(line).toContain('\x1b[38;2;32;112;104mmain\x1b[39m');
    expect(line).toContain('\x1b[38;2;30;32;40m23.4%/200k\x1b[39m');
    expect(line).toContain('\x1b[38;2;62;65;82m$0.000\x1b[39m');
    expect(line).toContain('\x1b[38;2;62;65;82mmodel\x1b[39m');
    expect(line).toContain('\x1b[38;2;124;50;168m• high\x1b[39m');
    app.ctx.getContextUsage = () => ({ percent: 75, contextWindow: 200000 }) as never;
    expect(footer.rawRender(100)[0]).toContain('\x1b[38;2;128;96;16m75.0%/200k\x1b[39m');
    app.ctx.getContextUsage = () => ({ percent: 95, contextWindow: 200000 }) as never;
    expect(footer.rawRender(100)[0]).toContain('\x1b[38;2;184;37;48m95.0%/200k\x1b[39m');
    expect(line).not.toContain('\x1b[48;');
    for (let color = 40; color <= 47; color += 1) {
      expect(line).not.toContain(`\x1b[${color}m`);
      expect(line).not.toContain(`\x1b[${color + 60}m`);
    }
  });
  it('refreshes dirty state at start tool results and branch changes outside render', async ({
    onTestFinished,
  }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-statusbar-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await git('git', ['init', '-q'], { cwd });
    const app = setup(cwd);
    await app.emit('session_start');
    const footer = app.mount();
    expect(footer.component.render(100)[0]).not.toContain('main*');
    await writeFile(join(cwd, 'file'), 'dirty');
    expect(footer.component.render(100)[0]).not.toContain('main*');
    // The tool_result handler refreshes off the agent's critical path, so it returns before git
    // answers and the marker trails it by a tick.
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
    await writeFile(join(cwd, 'file'), 'dirty');
    const dirty = setup(cwd);
    await dirty.emit('session_start');
    expect(dirty.mount().component.render(100)[0]).toContain('main*');
    expect(footer.requestRender).toHaveBeenCalled();
    footer.component.dispose?.();
    expect(footer.unsubscribe).toHaveBeenCalledOnce();
  });
  it('handles non-repositories and installs only in tui mode', async ({ onTestFinished }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-statusbar-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const app = setup(cwd);
    await app.emit('session_start');
    expect(app.mount().component.render(100)[0]).not.toContain('main*');
    for (const mode of ['rpc', 'json', 'print']) {
      const other = setup(cwd, mode);
      await other.emit('session_start');
      await other.emit('tool_result');
      expect(other.setFooter).not.toHaveBeenCalled();
    }
    expect([...app.handlers.keys()].toSorted()).toEqual(['session_start', 'tool_result']);
  });
  it('reads all usage categories and live model context and thinking state', async () => {
    const app = setup('/missing/tau/abu-347');
    const usage = { cost: { total: 0.103 } };
    app.ctx.sessionManager.getEntries = () =>
      [
        { type: 'message', message: { role: 'assistant', usage } },
        { type: 'message', message: { role: 'toolResult', usage } },
        { type: 'message', message: { role: 'toolResult' } },
        { type: 'compaction', usage },
        { type: 'branch_summary', usage },
        { type: 'compaction' },
        { type: 'message', message: { role: 'user' } },
      ] as never;
    app.ctx.model = { id: 'model', reasoning: true, contextWindow: 200000 } as never;
    app.ctx.getContextUsage = () => ({ percent: 23.4, contextWindow: 100000 }) as never;
    await app.emit('session_start');
    const footer = app.mount().component;
    expect(footer.render(100)[0]).toMatch(
      /^tau\/abu-347  main +\$0.412  23.4%\/100k  model • high$/,
    );
    app.ctx.getContextUsage = () => undefined;
    app.ctx.model = { id: 'plain', reasoning: false, contextWindow: 200000 } as never;
    expect(footer.render(100)[0]).toMatch(/\?\/200k  plain$/);
    app.ctx.model = undefined;
    expect(footer.render(100)[0]).toMatch(/\?\/0  no-model$/);
    expect(footer.render(100)).toHaveLength(1);
    expect(app.setFooter).toHaveBeenCalledOnce();
  });
});
