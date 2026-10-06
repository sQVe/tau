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
