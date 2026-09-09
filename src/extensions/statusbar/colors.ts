import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';

// Footer-only colors from Catppuccin Latte (Muted). Keep the terminal background unchanged.
const colors: Partial<Record<ThemeColor, string>> = {
  dim: '97;100;117',
  text: '30;32;40',
  muted: '62;65;82',
  accent: '32;112;104',
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
