import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import { questionDialog } from '../dialog.js';
import type { DialogQuestion, DialogResult } from '../dialog.js';

interface OpenedDialog {
  dialog: ReturnType<ReturnType<typeof questionDialog>>;
  results: DialogResult[];
  terminal: { rows: number; columns: number };
  requestRender: Mock<() => void>;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

export const problem = 'Decides how the first screen looks. Changing it later moves every panel.';
export const impact = 'The answer blocks the dashboard build.';
export const description = 'A long description that wraps over several lines on a narrow terminal.';
export const preview = Array.from({ length: 35 }, (_line, index) => `line ${index + 1}`).join('\n');
export const ctrlO = '\u000F';
export const escape = '\u001B';
export const down = '\u001B[B';

export const layoutQuestion = (options: DialogQuestion['options']): DialogQuestion => ({
  question: 'Which layout?',
  problem,
  impact,
  header: 'Layout',
  multiSelect: false,
  options,
});

export const open = (questions: DialogQuestion[], rows = 24, columns = 60): OpenedDialog => {
  const results: DialogResult[] = [];
  const terminal = { terminal: { rows, columns }, requestRender: vi.fn<() => void>() };

  const dialog = questionDialog(questions)(
    terminal as unknown as TUI,
    theme as unknown as Theme,
    undefined,
    (result) => results.push(result),
  );

  return {
    dialog,
    results,
    terminal: terminal.terminal,
    requestRender: terminal.requestRender,
  };
};

export const tallPreview = (rows = 24, question: Partial<DialogQuestion> = {}): OpenedDialog =>
  open(
    [
      {
        ...layoutQuestion([
          { label: 'Stacked', description, preview },
          { label: 'Split', description, preview: 'split' },
          { label: 'Tabs', description, preview: 'tabs' },
        ]),
        ...question,
      },
    ],
    rows,
  );

export const longProblem = `Decides the layout. ${'Every panel moves with it. '.repeat(14)}`.slice(
  0,
  397,
);

export const cache = (
  label: string,
  cost: string,
): { label: string; description: string; preview: string } => ({
  label,
  description: `Stores cached config in the ${label.toLowerCase()} so the files stay easy to inspect and debug for every clone. ${cost}`,
  preview: `${label}/config.json`,
});

export const previewLines = (count: number): string =>
  Array.from({ length: count }, (_line, index) => `row-${index + 1}`).join('\n');

export const rowCounts = Array.from({ length: 20 }, (_item, index) => index + 9);

export const previewFixture = (rows: number, lineCount = 8): OpenedDialog =>
  open(
    [
      layoutQuestion([
        {
          label: 'Stacked',
          description: 'Short.',
          preview: previewLines(lineCount),
        },
        { label: 'Split', description: 'Short.' },
      ]),
    ],
    rows,
    60,
  );
