import { stripVTControlCharacters } from 'node:util';

import type { ExtensionAPI, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

interface FooterInput {
  cost: number;
  contextPercent: number | null;
  contextWindow: number;
  modelId: string;
  thinkingLevel: ReturnType<ExtensionAPI['getThinkingLevel']> | undefined;
}

// Footer-only colors from Catppuccin Latte (Muted). Keep the terminal background unchanged.
const colors: Partial<Record<ThemeColor, string>> = {
  text: '30;32;40',
  muted: '62;65;82',
  warning: '128;96;16',
  error: '184;37;48',
  thinkingOff: '97;100;117',
  thinkingMinimal: '32;112;104',
  thinkingLow: '40;112;40',
  thinkingMedium: '32;96;144',
  thinkingHigh: '124;50;168',
  thinkingXhigh: '160;48;80',
  thinkingMax: '184;37;48',
};

export const footerTheme: Pick<Theme, 'fg'> = {
  fg: (color, text) => `\x1b[38;2;${colors[color] ?? colors.text}m${text}\x1b[39m`,
};

const sanitizeText = (text: string): string =>
  stripVTControlCharacters(text).replace(/\p{Cc}/gu, ' ');

const thousand = 1000;
const million = 1_000_000;
// Counts below ten units keep one decimal, such as 1.5k.
const decimalLimit = 10;

// Match Pi's footer token formatting without importing its internal component.
const formatTokens = (count: number): string => {
  if (count < thousand) {
    return count.toString();
  }

  if (count < decimalLimit * thousand) {
    return `${(count / thousand).toFixed(1)}k`;
  }

  if (count < million) {
    return `${Math.round(count / thousand)}k`;
  }

  if (count < decimalLimit * million) {
    return `${(count / million).toFixed(1)}M`;
  }

  return `${Math.round(count / million)}M`;
};

const contextErrorPercent = 90;
const contextWarningPercent = 70;
const costDecimals = 3;

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

  const percent = input.contextPercent;
  let contextColor: ThemeColor = 'text';

  if (percent !== null && percent > contextErrorPercent) {
    contextColor = 'error';
  } else if (percent !== null && percent > contextWarningPercent) {
    contextColor = 'warning';
  }

  const percentText = percent === null ? '?' : `${percent.toFixed(1)}%`;
  const context = `${percentText}/${formatTokens(input.contextWindow)}`;

  let model = theme.fg('muted', sanitizeText(input.modelId));

  if (input.thinkingLevel !== undefined) {
    model += ` ${theme.fg(thinkingColors[input.thinkingLevel], `• ${input.thinkingLevel}`)}`;
  }

  const line = [
    theme.fg('muted', `$${input.cost.toFixed(costDecimals)}`),
    theme.fg(contextColor, context),
    model,
  ].join('  ');

  const text = truncateToWidth(line, width);

  return ' '.repeat(width - visibleWidth(text)) + text;
};
