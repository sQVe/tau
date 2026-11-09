import { stripVTControlCharacters } from 'node:util';

import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { footerTheme, renderFooterLine } from './render.js';

const input = {
  cost: 0.412,
  contextPercent: 23.4,
  contextWindow: 200000,
  modelId: 'model',
  thinkingLevel: undefined,
};

const foreground = vi.fn<Theme['fg']>((_color, text) => text);
const theme = { fg: foreground };

describe('statusbar rendering', () => {
  it('renders external text without terminal controls or extra lines', () => {
    const line = renderFooterLine(
      { ...input, modelId: '\x1b[31mmodel\x1b[0m\nline\tname\x1b[2J' },
      100,
      footerTheme,
    );

    const text = stripVTControlCharacters(line);

    expect(text).toContain('model line name');
    expect(text).not.toMatch(/[\n\r\t]/);
    expect(line).not.toContain('\x1b[31m');
    expect(line).not.toContain('\x1b[2J');
    expect(visibleWidth(line)).toBe(100);
  });

  it('right-aligns the facts and truncates them to the width', () => {
    const line = '$0.412  23.4%/200k  model';

    expect(renderFooterLine(input, 80, theme)).toBe(' '.repeat(80 - line.length) + line);
    expect(renderFooterLine(input, 12, theme)).toBe(truncateToWidth(line, 12));
    expect(renderFooterLine(input, 0, theme)).toBe('');
    expect(visibleWidth(renderFooterLine({ ...input, modelId: '界界' }, 23, theme))).toBe(23);
  });

  it('keeps colored text within the width', () => {
    // ANSI truncation uses a different path from plain-text truncation.
    for (let width = 1; width <= 80; width += 1) {
      expect(visibleWidth(renderFooterLine(input, width, footerTheme))).toBeLessThanOrEqual(width);
    }

    for (const width of [80, 40, 24]) {
      expect(visibleWidth(renderFooterLine(input, width, footerTheme))).toBe(width);
    }
  });

  it('colors context at strict thresholds and shows unknown context', () => {
    for (const [percent, color] of [
      [70, 'text'],
      [70.1, 'warning'],
      [90, 'warning'],
      [90.1, 'error'],
    ] as const) {
      foreground.mockClear();

      renderFooterLine({ ...input, contextPercent: percent }, 80, theme);

      expect(foreground).toHaveBeenCalledWith(color, `${percent.toFixed(1)}%/200k`);
    }

    expect(renderFooterLine({ ...input, contextPercent: null }, 80, theme)).toContain('?/200k');
  });

  it('formats context window sizes', () => {
    for (const [contextWindow, text] of [
      [999, '999'],
      [1000, '1.0k'],
      [1500, '1.5k'],
      [10000, '10k'],
      [999999, '1000k'],
      [1000000, '1.0M'],
      [1500000, '1.5M'],
      [10000000, '10M'],
    ] as const) {
      expect(renderFooterLine({ ...input, contextWindow }, 80, theme)).toContain(`/${text}`);
    }
  });

  it('shows each thinking level with its color only when supplied', () => {
    for (const [thinkingLevel, color] of [
      ['off', 'thinkingOff'],
      ['minimal', 'thinkingMinimal'],
      ['low', 'thinkingLow'],
      ['medium', 'thinkingMedium'],
      ['high', 'thinkingHigh'],
      ['xhigh', 'thinkingXhigh'],
      ['max', 'thinkingMax'],
    ] as const) {
      foreground.mockClear();

      expect(renderFooterLine({ ...input, thinkingLevel }, 80, theme)).toContain(
        `model • ${thinkingLevel}`,
      );

      expect(foreground).toHaveBeenCalledWith(color, `• ${thinkingLevel}`);
    }

    expect(renderFooterLine(input, 80, theme)).not.toContain('•');
  });
});
