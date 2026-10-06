import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS as tuiKeybindings } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';

import { customContext } from '../tests/toolContext.js';
import { confirm } from './confirm.js';

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme;

it.each([
  { name: 'Yes by default', keys: ['\r'], answer: true },
  { name: 'No after down', keys: ['\u001B[B', '\r'], answer: false },
  { name: 'cancel', keys: ['\u001B'], answer: false },
  { name: 'Yes after up', keys: ['\u001B[B', '\u001B[A', '\r'], answer: true },
  { name: 'No with j', keys: ['j', '\r'], answer: false },
  { name: 'Yes with k', keys: ['j', 'k', '\r'], answer: true },
  { name: 'upper boundary', keys: ['k', '\r'], answer: true },
  { name: 'lower boundary', keys: ['j', 'j', '\r'], answer: false },
  { name: 'line feed', keys: ['\n'], answer: true },
  { name: 'No with G', keys: ['G', '\r'], answer: false },
  { name: 'Yes with g', keys: ['G', 'g', '\r'], answer: true },
  { name: 'No with End', keys: ['\u001B[F', '\r'], answer: false },
  { name: 'Yes with Home', keys: ['\u001B[F', '\u001B[H', '\r'], answer: true },
  { name: 'undefined custom result', keys: [], answer: false },
])('returns the answer for $name', async ({ keys, answer }) => {
  const context = customContext((component) => {
    for (const key of keys) {
      component.handleInput?.(key);
    }
  }, theme);

  expect(await confirm(context, 'Title', 'Message')).toBe(answer);
});

it('uses the supplied keybindings', async () => {
  const keybindings = new KeybindingsManager(tuiKeybindings, { 'tui.select.down': 'x' });

  const context = customContext(
    (component) => {
      component.handleInput?.('x');
      component.handleInput?.('\r');
    },
    theme,
    keybindings,
  );

  expect(await confirm(context, 'Title', 'Message')).toBe(false);
});

it('toggles tool output without closing the dialog', async () => {
  const keybindings = new KeybindingsManager({
    ...tuiKeybindings,
    'app.tools.expand': { defaultKeys: 'ctrl+o', description: 'Toggle tool output' },
  });

  const context = customContext(
    (component) => {
      component.handleInput?.('\u000F');
      component.handleInput?.('\r');
    },
    theme,
    keybindings,
  );

  let expanded = false;

  context.ui.getToolsExpanded = () => expanded;

  context.ui.setToolsExpanded = (value) => {
    expanded = value;
  };

  expect(await confirm(context, 'Title', 'Message')).toBe(true);
  expect(expanded).toBe(true);
});

it('renders the title in bold accent and the message in normal text', async () => {
  let rendered = '';

  const context = customContext((component) => {
    rendered = component.render(200).join('\n');
    component.handleInput?.('\r');
  }, theme);

  await confirm(context, 'Title', 'Message');

  expect(rendered).toContain('<accent><bold>Title</bold></accent>');
  expect(rendered).toContain('<text>Message</text>');
  expect(rendered).not.toContain('<accent>Message');
  expect(rendered).not.toContain('<bold>Message');
});

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

it.each([12, 24])('keeps long confirmations within a %s-row terminal', async (rows) => {
  const message = Array.from({ length: 40 }, (_, index) => `Write ${index + 1}`).join('\n');
  const pages: string[][] = [];

  const context = customContext(
    (component) => {
      pages.push(component.render(80));

      for (let index = 0; index < 45; index += 1) {
        component.handleInput?.('\u001B[6~');
        pages.push(component.render(80));
      }

      component.handleInput?.('\r');
    },
    plainTheme,
    undefined,
    { rows, columns: 80 },
  );

  expect(await confirm(context, 'Review writes', message)).toBe(true);

  for (const page of pages) {
    expect(page.length).toBeLessThanOrEqual(rows - 6);
    expect(page.join('\n')).toContain('Review writes');
    expect(page.join('\n')).toContain('Yes');
    expect(page.join('\n')).toContain('No');
  }

  expect(pages[0]?.join('\n')).toContain('Write 1');
  expect(pages[0]?.join('\n')).not.toContain('Write 40');
  expect(pages.at(-1)?.join('\n')).toContain('Write 40');

  for (const line of message.split('\n')) {
    const visited = pages.some((page) => page.some((row) => row.trim() === line));

    expect(visited).toBe(true);
  }
});

it('scrolls wrapped message rows both ways without changing No selection', async () => {
  const pages: string[] = [];
  const message = `${'word '.repeat(180)}last-write`;

  const context = customContext(
    (component) => {
      component.handleInput?.('j');
      pages.push(component.render(50).join('\n'));

      for (let index = 0; index < 40; index += 1) {
        component.handleInput?.('\u001B[6~');
        component.render(50);
      }

      pages.push(component.render(50).join('\n'));

      for (let index = 0; index < 40; index += 1) {
        component.handleInput?.('\u001B[5~');
        component.render(50);
      }

      pages.push(component.render(50).join('\n'));
      component.handleInput?.('\r');
    },
    plainTheme,
    undefined,
    { rows: 18, columns: 50 },
  );

  expect(await confirm(context, 'Review writes', message)).toBe(false);
  expect(pages[0]).not.toContain('last-write');
  expect(pages[1]).toContain('last-write');
  expect(pages[2]).toBe(pages[0]);
});

it('refits the message after terminal height and width changes', async () => {
  const dimensions = { rows: 18, columns: 80 };
  const message = Array.from({ length: 30 }, (_, index) => `Write ${index + 1}`).join('\n');
  const pages: string[][] = [];

  const context = customContext(
    (component) => {
      component.render(dimensions.columns);

      for (let index = 0; index < 30; index += 1) {
        component.handleInput?.('\u001B[6~');
        component.render(dimensions.columns);
      }

      dimensions.rows = 24;
      dimensions.columns = 40;
      component.invalidate();
      pages.push(component.render(dimensions.columns));
      dimensions.rows = 80;
      pages.push(component.render(dimensions.columns));
      dimensions.rows = 12;
      pages.push(component.render(dimensions.columns));
      component.handleInput?.('\u001B');
    },
    plainTheme,
    undefined,
    dimensions,
  );

  expect(await confirm(context, 'Review writes', message)).toBe(false);
  expect(pages[0]?.length).toBeLessThanOrEqual(18);
  expect(pages[0]?.join('\n')).toContain('Write 30');
  expect(pages[1]?.join('\n')).toContain('Write 1');
  expect(pages[1]?.join('\n')).toContain('Write 30');
  expect(pages[2]?.length).toBeLessThanOrEqual(6);
  expect(pages[2]?.join('\n')).toContain('Write 1');
  expect(pages[2]?.join('\n')).not.toContain('Write 30');
});

it.each([true, false])('returns the non-TUI confirm answer %s', async (answer) => {
  const fallback = vi
    .fn<(title: string, message: string) => Promise<boolean>>()
    .mockResolvedValue(answer);

  const custom = vi.fn<() => void>();

  const context = {
    mode: 'rpc',
    hasUI: true,
    ui: { confirm: fallback, custom },
  } as unknown as ExtensionContext;

  expect(await confirm(context, 'Title', 'Message')).toBe(answer);
  expect(fallback).toHaveBeenCalledWith('Title', 'Message');
  expect(custom).not.toHaveBeenCalled();
});
