import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { renderFooterLine } from './render.js';

const input = {
  directory: 'tau/abu-347',
  branch: 'main',
  dirty: false,
  cost: 0.412,
  contextPercent: 23.4,
  contextWindow: 200000,
  modelId: 'model',
  thinkingLevel: undefined,
};
const fg = vi.fn<Theme['fg']>((_color, text) => text);
const theme = { fg };

describe('statusbar rendering', () => {
  it('aligns groups and truncates the right group before the left', () => {
    const left = 'tau/abu-347  main';
    const right = '$0.412  23.4%/200k  model';
    expect(renderFooterLine(input, 80, theme)).toBe(
      left + ' '.repeat(80 - left.length - right.length) + right,
    );
    expect(renderFooterLine(input, 24, theme)).toBe(
      left + '  ' + truncateToWidth(right, 24 - left.length - 2),
    );
    expect(renderFooterLine(input, 8, theme)).toBe(truncateToWidth(left, 8));
    expect(renderFooterLine(input, 0, theme)).toBe('');
    expect(visibleWidth(renderFooterLine({ ...input, directory: '界/界' }, 25, theme))).toBe(25);
  });
  it('keeps the line within the width once the colors are real escape codes', () => {
    // The identity fg above takes truncateToWidth's plain-ASCII path, which production never does.
    const colored = { fg: (color, text) => `\x1b[38;2;1;2;3m${text}\x1b[39m` } satisfies Pick<
      Theme,
      'fg'
    >;
    // The line is only guaranteed to fit the width. It fills it when the right group survives.
    for (let width = 1; width <= 80; width += 1) {
      expect(visibleWidth(renderFooterLine(input, width, colored))).toBeLessThanOrEqual(width);
    }
    for (const width of [80, 40, 24]) {
      expect(visibleWidth(renderFooterLine(input, width, colored))).toBe(width);
    }
  });
  it('colors the directory branch and dirty marker and omits missing branches', () => {
    fg.mockClear();
    expect(renderFooterLine({ ...input, dirty: true }, 80, theme)).toContain('main*');
    expect(fg).toHaveBeenCalledWith('dim', 'tau/abu-347');
    expect(fg).toHaveBeenCalledWith('accent', 'main');
    expect(fg).toHaveBeenCalledWith('warning', '*');
    expect(renderFooterLine({ ...input, branch: null, dirty: true }, 80, theme)).not.toMatch(
      /main|\*/,
    );
  });
  it('colors context at strict thresholds and shows unknown context', () => {
    for (const [percent, color] of [
      [70, 'text'],
      [70.1, 'warning'],
      [90, 'warning'],
      [90.1, 'error'],
    ] as const) {
      fg.mockClear();
      renderFooterLine({ ...input, contextPercent: percent }, 80, theme);
      expect(fg).toHaveBeenCalledWith(color, `${percent.toFixed(1)}%/200k`);
    }
    expect(renderFooterLine({ ...input, contextPercent: null }, 80, theme)).toContain('?/200k');
    for (const [contextWindow, text] of [
      [999, '999'],
      [1500, '1.5k'],
      [10000, '10k'],
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
      fg.mockClear();
      expect(renderFooterLine({ ...input, thinkingLevel }, 80, theme)).toContain(
        `model • ${thinkingLevel}`,
      );
      expect(fg).toHaveBeenCalledWith(color, `• ${thinkingLevel}`);
    }
    expect(renderFooterLine(input, 80, theme)).not.toContain('•');
  });
});
