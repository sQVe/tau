import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import { questionDialog } from './dialog.js';

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const terminal = { terminal: { rows: 24 }, requestRender: () => undefined };
const description = 'A long description that wraps over several lines on a narrow terminal.';
const preview = Array.from({ length: 35 }, (_line, index) => `line ${index + 1}`).join('\n');

it("leaves room for Pi's footer below a tall preview", () => {
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

  expect(lines.length).toBeLessThanOrEqual(18);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('line 1'))).toBe(true);
  expect(lines.some((line) => line.includes('line 35'))).toBe(false);
});

it('keeps the question and the focused option on screen when the options are too tall', () => {
  const dialog = questionDialog([
    {
      question: 'Which runtime?',
      header: 'Runtime',
      multiSelect: false,
      options: ['Node', 'Deno', 'Bun', 'Workers'].map((label) => ({ label, description })),
    },
  ])(terminal as unknown as TUI, theme as unknown as Theme, undefined, () => undefined);

  dialog.handleInput('G');
  dialog.handleInput('\u001B[A');

  const lines = dialog.render(30);

  expect(lines.length).toBeLessThanOrEqual(18);
  expect(lines.some((line) => line.includes('Which runtime?'))).toBe(true);
  expect(lines.some((line) => line.includes('> 4. Workers'))).toBe(true);
});
