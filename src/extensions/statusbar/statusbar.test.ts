import { stripVTControlCharacters } from 'node:util';

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import statusbarExtension from './statusbar.js';

const setup = (mode = 'tui') => {
  const fake = fakeExtensionApi({ getThinkingLevel: () => 'high' });
  const setFooter = vi.fn<ExtensionContext['ui']['setFooter']>();
  const session = { id: 'session-1', leafId: 'entry-1' as string | null, entryCount: 1 };

  const context = {
    mode,
    ui: { setFooter },
    sessionManager: {
      getSessionId: () => session.id,
      getLeafId: () => session.leafId,
      getEntryCount: () => session.entryCount,
      getEntries: () => [],
    },
    getContextUsage: () => undefined,
  } as unknown as ExtensionContext;

  const emit = async (name: string) => {
    if (fake.handlers.has(name)) {
      await fake.handler(name)({}, context);
    }
  };

  const mount = () => {
    const factory = setFooter.mock.calls.at(-1)?.[0];

    if (factory === undefined) {
      throw new Error('No footer factory registered');
    }

    const component = factory(
      { requestRender: () => {} } as never,
      { fg: (_color: string, text: string) => text } as Theme,
      {
        getGitBranch: () => 'main',
        getAvailableProviderCount: () => 1,
        onBranchChange: () => () => {},
        getExtensionStatuses: () => new Map([['hidden', 'HIDDEN']]),
      },
    );

    const rawRender = component.render.bind(component);
    component.render = (width) => rawRender(width).map(stripVTControlCharacters);

    return { rawRender, component };
  };

  statusbarExtension(fake.pi);

  return { context, session, emit, mount, setFooter };
};

describe('statusbar extension', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the Latte colors without a background', async () => {
    const application = setup();
    application.context.model = { id: 'model', reasoning: true, contextWindow: 200000 } as never;

    application.context.getContextUsage = () => ({
      tokens: 46800,
      percent: 23.4,
      contextWindow: 200000,
    });

    await application.emit('session_start');

    const footer = application.mount();
    const line = footer.rawRender(100)[0];

    expect(line).toContain('\x1b[38;2;30;32;40m23.4%/200k\x1b[39m');
    expect(line).toContain('\x1b[38;2;62;65;82m$0.000\x1b[39m');
    expect(line).toContain('\x1b[38;2;62;65;82mmodel\x1b[39m');
    expect(line).toContain('\x1b[38;2;124;50;168m• high\x1b[39m');
    expect(line).not.toContain('\x1b[48;');

    for (let color = 40; color <= 47; color += 1) {
      expect(line).not.toContain(`\x1b[${color}m`);
      expect(line).not.toContain(`\x1b[${color + 60}m`);
    }

    application.context.getContextUsage = () => ({
      tokens: 150000,
      percent: 75,
      contextWindow: 200000,
    });

    application.session.entryCount += 1;

    expect(footer.rawRender(100)[0]).toContain('\x1b[38;2;128;96;16m75.0%/200k\x1b[39m');

    application.context.getContextUsage = () => ({
      tokens: 190000,
      percent: 95,
      contextWindow: 200000,
    });

    application.session.entryCount += 1;

    expect(footer.rawRender(100)[0]).toContain('\x1b[38;2;184;37;48m95.0%/200k\x1b[39m');

    footer.component.dispose?.();
  });

  it.each(['rpc', 'json', 'print'])('does not install in %s mode', async (mode) => {
    const application = setup(mode);

    await application.emit('session_start');

    expect(application.setFooter).not.toHaveBeenCalled();
  });

  it('reads all usage categories and live model context and thinking state', async () => {
    const application = setup();
    const usage = { cost: { total: 0.103 } };

    application.context.sessionManager.getEntries = () =>
      [
        { type: 'message', message: { role: 'assistant', usage } },
        { type: 'message', message: { role: 'toolResult', usage } },
        { type: 'message', message: { role: 'toolResult' } },
        { type: 'compaction', usage },
        { type: 'branch_summary', usage },
        { type: 'compaction' },
        { type: 'message', message: { role: 'user' } },
      ] as never;

    application.context.model = { id: 'model', reasoning: true, contextWindow: 200000 } as never;

    application.context.getContextUsage = () => ({
      tokens: 23400,
      percent: 23.4,
      contextWindow: 100000,
    });

    await application.emit('session_start');

    const footer = application.mount().component;

    expect(footer.render(100)[0]).toMatch(/^ +\$0.412  23.4%\/100k  model • high$/);

    application.context.getContextUsage = () => undefined;
    application.context.model = { id: 'plain', reasoning: false, contextWindow: 200000 } as never;

    expect(footer.render(100)[0]).toMatch(/\?\/200k  plain$/);

    application.context.model = undefined;

    expect(footer.render(100)[0]).toMatch(/\?\/0  no-model$/);
    expect(footer.render(100)).toHaveLength(1);
    expect(application.setFooter).toHaveBeenCalledOnce();

    footer.dispose?.();
  });

  it('counts cache warmer usage entries in the session cost', async () => {
    const application = setup();

    application.context.sessionManager.getEntries = () =>
      [{ type: 'usage', kind: 'cache_warm', usage: { cost: { total: 0.25 } } }] as never;

    await application.emit('session_start');

    const footer = application.mount().component;

    expect(footer.render(100)[0]).toMatch(/^ +\$0\.250 /);

    footer.dispose?.();
  });

  const mountCountingFooter = async () => {
    vi.useFakeTimers({ now: 10_000 });

    const application = setup();
    const getEntries = vi.fn<() => never[]>(() => []);
    const getContextUsage = vi.fn<() => undefined>(() => undefined);

    application.context.sessionManager.getEntries = getEntries;
    application.context.getContextUsage = getContextUsage;
    application.context.model = { id: 'model', contextWindow: 200000 } as never;

    await application.emit('session_start');

    const footer = application.mount().component;

    return { application, footer, getEntries, getContextUsage };
  };

  it('reads session cost and context usage once within a second of an unchanged session', async () => {
    const { footer, getEntries, getContextUsage } = await mountCountingFooter();

    footer.render(100);
    vi.advanceTimersByTime(999);
    footer.render(100);
    footer.render(80);

    expect(getEntries).toHaveBeenCalledOnce();
    expect(getContextUsage).toHaveBeenCalledOnce();

    footer.dispose?.();
  });

  it('reads context usage again after a second but keeps the session cost', async () => {
    const { footer, getEntries, getContextUsage } = await mountCountingFooter();

    footer.render(100);
    vi.advanceTimersByTime(1000);
    footer.render(100);

    expect(getEntries).toHaveBeenCalledOnce();
    expect(getContextUsage).toHaveBeenCalledTimes(2);

    footer.dispose?.();
  });

  it('reads context usage again after a second when the wall clock moves back', async () => {
    const { footer, getContextUsage } = await mountCountingFooter();

    footer.render(100);
    vi.setSystemTime(Date.now() - 5000);
    vi.advanceTimersByTime(1000);
    footer.render(100);

    expect(getContextUsage).toHaveBeenCalledTimes(2);

    footer.dispose?.();
  });

  it('reads session cost and context usage again after invalidation', async () => {
    const { footer, getEntries, getContextUsage } = await mountCountingFooter();

    footer.render(100);
    footer.invalidate();
    footer.render(100);

    expect(getEntries).toHaveBeenCalledTimes(2);
    expect(getContextUsage).toHaveBeenCalledTimes(2);

    footer.dispose?.();
  });

  it.each([
    [
      'a new session',
      2,
      (application: ReturnType<typeof setup>) => {
        application.session.id = 'session-2';
      },
    ],
    [
      'a new leaf',
      2,
      (application: ReturnType<typeof setup>) => {
        application.session.leafId = 'entry-2';
      },
    ],
    [
      'a new entry',
      2,
      (application: ReturnType<typeof setup>) => {
        application.session.entryCount += 1;
      },
    ],
    [
      'a new model',
      1,
      (application: ReturnType<typeof setup>) => {
        application.context.model = { id: 'other', contextWindow: 100000 } as never;
      },
    ],
  ])('reads context usage again after %s', async (_change, costReads, change) => {
    const { application, footer, getEntries, getContextUsage } = await mountCountingFooter();

    footer.render(100);
    change(application);
    footer.render(100);

    expect(getEntries).toHaveBeenCalledTimes(costReads);
    expect(getContextUsage).toHaveBeenCalledTimes(2);

    footer.dispose?.();
  });

  it('counts entries from the entry list when the session manager cannot count them', async () => {
    const application = setup();
    const entries: never[] = [];
    const getContextUsage = vi.fn<() => undefined>(() => undefined);

    Reflect.deleteProperty(application.context.sessionManager, 'getEntryCount');
    application.context.sessionManager.getEntries = () => entries;
    application.context.getContextUsage = getContextUsage;

    await application.emit('session_start');

    const footer = application.mount().component;

    footer.render(100);
    footer.render(100);
    entries.push({ type: 'message', message: { role: 'user' } } as never);
    footer.render(100);

    expect(getContextUsage).toHaveBeenCalledTimes(2);

    footer.dispose?.();
  });

  it('shows changed routed model limits within a second', async () => {
    vi.useFakeTimers({ now: 10_000 });

    const application = setup();
    const routed = { contextWindow: 100000 };

    application.context.model = { id: 'smart', api: 'pi-virtual', contextWindow: 0 } as never;

    application.context.getContextUsage = () => ({
      tokens: 10000,
      percent: (10000 / routed.contextWindow) * 100,
      contextWindow: routed.contextWindow,
    });

    await application.emit('session_start');

    const footer = application.mount().component;

    expect(footer.render(100)[0]).toContain('10.0%/100k');

    routed.contextWindow = 200000;

    expect(footer.render(100)[0]).toContain('10.0%/100k');

    vi.advanceTimersByTime(1000);

    expect(footer.render(100)[0]).toContain('5.0%/200k');

    footer.dispose?.();
  });
});
