import type { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import { bottomBorder, boxLine, topBorder } from './box.js';

const theme: Pick<Theme, 'fg'> = { fg: (_color, text) => text };

it('draws a box frame at the given width', () => {
  expect([
    topBorder(' Notes ', '', 16, theme),
    boxLine('text', 16, theme),
    bottomBorder(16, theme),
  ]).toEqual(['╭ Notes ───────╮', '│ text         │', '╰──────────────╯']);
});

it('puts the right label at the end of the top border', () => {
  expect(topBorder('─ Left ', ' 2 live ', 20, theme)).toBe('╭─ Left ─── 2 live ╮');
});

it('cuts content that is wider than the box', () => {
  const line = boxLine('a'.repeat(30), 16, theme);

  expect(visibleWidth(line)).toBe(16);
  expect(stripTerminalSequences(line)).toBe(`│ ${'a'.repeat(11)}… │`);
});

it('keeps the frame within widths too narrow for a box', () => {
  const lines = [
    topBorder(' Notes ', '', 1, theme),
    boxLine('text', 2, theme),
    bottomBorder(3, theme),
  ];

  expect(lines.map((line) => visibleWidth(line))).toEqual([1, 1, 2]);
});
