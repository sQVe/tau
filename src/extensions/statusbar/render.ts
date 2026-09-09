import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import type { FooterInput } from './types.js';

// Match Pi's footer token formatting without importing its internal component.
const formatTokens = (count: number): string => {
  if (count < 1000) {
    return count.toString();
  }
  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  if (count < 1000000) {
    return `${Math.round(count / 1000)}k`;
  }
  if (count < 10000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  return `${Math.round(count / 1000000)}M`;
};

const thinkingColors = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax',
} satisfies Record<NonNullable<FooterInput['thinkingLevel']>, ThemeColor>;

export const renderFooterLine = (
  input: FooterInput,
  width: number,
  theme: Pick<Theme, 'fg'>,
): string => {
  if (width <= 0) {
    return '';
  }
  const left = [theme.fg('dim', input.directory)];
  if (input.branch !== null) {
    left.push(theme.fg('accent', input.branch) + (input.dirty ? theme.fg('warning', '*') : ''));
  }
  const percent = input.contextPercent;
  let contextColor: ThemeColor = 'text';
  if (percent !== null && percent > 90) {
    contextColor = 'error';
  } else if (percent !== null && percent > 70) {
    contextColor = 'warning';
  }
  const context = `${percent === null ? '?' : `${percent.toFixed(1)}%`}/${formatTokens(input.contextWindow)}`;
  let model = theme.fg('muted', input.modelId);
  if (input.thinkingLevel !== undefined) {
    model += ` ${theme.fg(thinkingColors[input.thinkingLevel], `• ${input.thinkingLevel}`)}`;
  }
  const right = [
    theme.fg('muted', `$${input.cost.toFixed(3)}`),
    theme.fg(contextColor, context),
    model,
  ].join('  ');
  const leftText = truncateToWidth(left.join('  '), width);
  const leftWidth = visibleWidth(leftText);
  const rightWidth = width - leftWidth - 2;
  if (rightWidth <= 0) {
    return leftText;
  }
  const rightText = truncateToWidth(right, rightWidth);
  return leftText + ' '.repeat(width - leftWidth - visibleWidth(rightText)) + rightText;
};
