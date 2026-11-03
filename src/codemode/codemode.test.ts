import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { fakeExtensionApi } from '../../tests/extensionApi.js';
import { registerCodemodeBudget } from './codemode.js';

const itemText = (firstLine: string, length: number): string =>
  `${firstLine}\n${'a'.repeat(length - firstLine.length - 1)}`;

it('cuts whole items one character over the budget and saves the full text', async ({
  onTestFinished,
}) => {
  const fake = fakeExtensionApi();
  const checkCall = registerCodemodeBudget(fake.pi);
  const toolCallId = 'codemode-call-1';

  const code =
    '// @options: {"max_output_tokens": 1000}\n// @budget: Checking the cut.\ntext("done");';

  const callEvent = { type: 'tool_call', toolCallId, toolName: 'codemode', input: { code } };

  expect(checkCall(callEvent as ToolCallEvent)).toBeUndefined();

  const items = [
    itemText('first item', 1000),
    itemText('second item', 1499),
    itemText('third item', 1500),
  ];

  const result = (await fake.handler('tool_result')(
    {
      type: 'tool_result',
      toolCallId,
      toolName: 'codemode',
      content: [
        { type: 'text', text: 'Script output' },
        ...items.map((text) => ({ type: 'text', text })),
      ],
      isError: false,
      details: undefined,
    },
    {} as ExtensionContext,
  )) as { content: { type: 'text'; text: string }[] };

  const [header, kept, gap] = result.content;
  const path = gap?.text.match(/Full output: (.+)\]$/m)?.[1];

  if (path !== undefined) {
    onTestFinished(() => rm(dirname(path), { recursive: true, force: true }));
  }

  expect(header?.text).toBe('Script output');
  expect(kept?.text).toBe(items[0]);
  expect(result.content).toHaveLength(3);

  expect(gap?.text).toContain('item 2: "second item" (1499 characters)');
  expect(gap?.text).toContain('item 3: "third item" (1500 characters)');

  expect(path).toBeDefined();

  const saved = await readFile(path ?? '', 'utf8');

  expect(saved).toBe(items.join('\n'));
});
