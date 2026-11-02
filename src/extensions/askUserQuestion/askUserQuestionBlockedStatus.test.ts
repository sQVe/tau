import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolDefinition, Theme } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { customContext } from '../../../tests/toolContext.js';
import askUserQuestionExtension from './askUserQuestion.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const layout = {
  question: 'Which layout should the dashboard use?',
  problem: 'The dashboard ships next week.',
  impact: 'Changing the layout later moves every panel.',
  header: 'Layout',
  options: [
    { label: 'Stacked', description: 'One column. Simple, but wide screens waste space.' },
    { label: 'Split', description: 'Two columns. Uses wide screens, but needs a fallback.' },
  ],
};

it('reports a blocked question with the first header while the question dialog is open', async () => {
  const fake = fakeExtensionApi();

  askUserQuestionExtension(fake.pi);

  const tool = fake.tools.get('ask_user_question');

  if (tool === undefined) {
    throw new Error('The extension registered no tool.');
  }

  const params: Parameters<ToolDefinition['execute']>[1] = validateToolArguments(tool, {
    type: 'toolCall',
    id: 'call',
    name: tool.name,
    arguments: { questions: [layout] },
  });

  const opened = customContext(() => undefined, theme);

  const context = {
    ...opened,
    sessionManager: { ...opened.sessionManager, getBranch: () => [] },
  };

  await tool.execute('call', params, undefined, undefined, context);

  expect(opened.programStatusReports).toEqual([
    { state: 'blocked', app: 'pi', kind: 'question', message: 'Layout' },
    { state: 'working', app: 'pi', message: 'session' },
  ]);
});
