import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

// Two border columns and two padding columns.
export const boxFrameWidth = 4;

export const topBorder = (
  left: string,
  right: string,
  width: number,
  theme: Pick<Theme, 'fg'>,
): string => {
  if (width < boxFrameWidth) {
    return truncateToWidth('╭─', width);
  }

  const inside = width - 2;
  const fittedRight = truncateToWidth(right, inside, '…');
  const leftWidth = Math.max(0, inside - visibleWidth(fittedRight));
  const fittedLeft = truncateToWidth(left, leftWidth, '…');
  const availableFill = Math.max(0, inside - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
  const line = `${fittedLeft}${'─'.repeat(availableFill)}${fittedRight}`;

  return `${theme.fg('border', '╭')}${theme.fg('accent', truncateToWidth(line, inside))}${theme.fg('border', '╮')}`;
};

export const boxLine = (content: string, width: number, theme: Pick<Theme, 'fg'>): string => {
  if (width < boxFrameWidth) {
    return truncateToWidth('│', width);
  }

  const innerWidth = width - boxFrameWidth;
  const fitted = truncateToWidth(content, innerWidth, '…');
  const line = `${theme.fg('border', '│')} ${fitted}${' '.repeat(Math.max(0, innerWidth - visibleWidth(fitted)))} ${theme.fg('border', '│')}`;

  return line;
};

export const bottomBorder = (width: number, theme: Pick<Theme, 'fg'>): string => {
  if (width < boxFrameWidth) {
    return truncateToWidth('╰─', width);
  }

  const line = `╰${'─'.repeat(width - 2)}╯`;

  return theme.fg('border', line);
};
