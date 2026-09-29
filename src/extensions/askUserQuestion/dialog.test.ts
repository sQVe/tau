import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import { questionDialog } from './dialog.js';

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const preview = Array.from({ length: 35 }, (_line, index) => `line ${index + 1}`).join('\n');

it('keeps the question and options on screen with a tall preview', () => {
  const terminal = { terminal: { rows: 24 }, requestRender: () => undefined };

  const dialog = questionDialog([
    {
      question: 'Which layout?',
      header: 'Layout',
      multiSelect: false,
      options: [
        { label: 'Stacked', description: 'One column.', preview },
        { label: 'Split', description: 'Two columns.' },
      ],
    },
  ])(terminal as unknown as TUI, theme as unknown as Theme, undefined, () => undefined);

  const lines = dialog.render(60);

  expect(lines.length).toBeLessThanOrEqual(24);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('line 1'))).toBe(true);
  expect(lines.some((line) => line.includes('line 35'))).toBe(false);
});
