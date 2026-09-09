import { stripVTControlCharacters } from 'node:util';

import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { footerTheme } from './colors.js';
import { renderFooterLine } from './render.js';

const input = {
  directory: 'tau/abu-347',
  branch: 'main',
  dirty: false,
  tddGateOff: false,
  cost: 0.412,
  contextPercent: 23.4,
  contextWindow: 200000,
  modelId: 'model',
  thinkingLevel: undefined,
};
const foreground = vi.fn<Theme['fg']>((_color, text) => text);
const theme = { fg: foreground };

describe('statusbar rendering', () => {
  it('shows the gate-off glyph in warning color after the dirty branch', () => {
    const gateOffInput = { ...input, dirty: true, tddGateOff: true };
    const line = renderFooterLine(gateOffInput, 80, footerTheme);

    expect(stripVTControlCharacters(line)).toContain('tau/abu-347  main*  \u{F0FC6}');
    expect(line).toContain(footerTheme.fg('warning', '\u{F0FC6}'));
    expect(renderFooterLine(input, 80, footerTheme)).not.toContain('\u{F0FC6}');

    for (const width of [0, 1, 8, 19, 20, 21, 24, 40, 80]) {
      const narrowLine = renderFooterLine(gateOffInput, width, footerTheme);

      expect(visibleWidth(narrowLine)).toBeLessThanOrEqual(width);
      expect(narrowLine.includes('\u{F0FC6}')).toBe(
        width >= visibleWidth('tau/abu-347  main*  \u{F0FC6}'),
      );
    }
  });

  it('renders external text without terminal controls or extra lines', () => {
    const line = renderFooterLine(
      {
        ...input,
        directory: 'tau/line\nbreak',
        branch: '\x1b[31mmain\x1b[0m',
        modelId: 'model\tname\x1b[2J',
      },
      100,
      footerTheme,
    );
    const text = stripVTControlCharacters(line);

    expect(text).toContain('tau/line break  main');
    expect(text).toContain('model name');
    expect(text).not.toMatch(/[\n\r\t]/);
    expect(line).not.toContain('\x1b[31m');
    expect(line).not.toContain('\x1b[2J');
    expect(visibleWidth(line)).toBe(100);
  });

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

  it('keeps colored text within the width', () => {
    // ANSI truncation uses a different path from plain-text truncation.
    for (let width = 1; width <= 80; width += 1) {
      expect(visibleWidth(renderFooterLine(input, width, footerTheme))).toBeLessThanOrEqual(width);
    }

    for (const width of [80, 40, 24]) {
      expect(visibleWidth(renderFooterLine(input, width, footerTheme))).toBe(width);
    }
  });

  it('colors the directory branch and dirty marker and omits missing branches', () => {
    foreground.mockClear();

    expect(renderFooterLine({ ...input, dirty: true }, 80, theme)).toContain('main*');
    expect(foreground).toHaveBeenCalledWith('dim', 'tau/abu-347');
    expect(foreground).toHaveBeenCalledWith('accent', 'main');
    expect(foreground).toHaveBeenCalledWith('warning', '*');
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
      foreground.mockClear();

      renderFooterLine({ ...input, contextPercent: percent }, 80, theme);

      expect(foreground).toHaveBeenCalledWith(color, `${percent.toFixed(1)}%/200k`);
    }

    expect(renderFooterLine({ ...input, contextPercent: null }, 80, theme)).toContain('?/200k');
  });

  it('formats context window sizes', () => {
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
      foreground.mockClear();

      expect(renderFooterLine({ ...input, thinkingLevel }, 80, theme)).toContain(
        `model • ${thinkingLevel}`,
      );
      expect(foreground).toHaveBeenCalledWith(color, `• ${thinkingLevel}`);
    }

    expect(renderFooterLine(input, 80, theme)).not.toContain('•');
  });
});
