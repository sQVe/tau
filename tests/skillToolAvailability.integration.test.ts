import { join } from 'node:path';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import codeReviewExtension from '../src/extensions/codeReview/codeReview.js';
import handoverExtension from '../src/extensions/handover/handover.js';
import prExtension from '../src/extensions/pr/pr.js';
import prFeedbackExtension from '../src/extensions/prFeedback/prFeedback.js';
import sliceExtension from '../src/extensions/slice/slice.js';
import trackerExtension from '../src/extensions/tracker/tracker.js';
import { skillTools } from '../src/skillTools.js';
import { createTemporaryRepository } from './gitRepository.js';
import { createBoundSession } from './piSession.js';

// Real Pi sessions need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

const registerTools = (pi: ExtensionAPI) => {
  codeReviewExtension(pi);
  handoverExtension(pi);
  prExtension(pi);
  prFeedbackExtension(pi);
  sliceExtension(pi);
  trackerExtension(pi);
};

it('declares every skill tool on the first manager request and accepts a direct call', async ({
  onTestFinished,
}) => {
  const directory = await createTemporaryRepository(onTestFinished, 'tau-skill-tools-');
  const provider = fauxProvider({ provider: 'tau-skill-tools' });

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: join(directory, 'agent'),
    providers: [provider],
    extensionFactories: [registerTools],
  });

  const declarations: string[][] = [];
  const results: { isError: boolean; result: unknown }[] = [];

  session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.toolName === 'slice') {
      results.push({ isError: event.isError, result: event.result });
    }
  });

  provider.setResponses([
    (context) => {
      declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));

      return fauxAssistantMessage([fauxToolCall('slice', { action: 'prepare', id: 'first' })]);
    },
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Prepare a slice draft.');

  for (const tools of Object.values(skillTools)) {
    for (const tool of tools) {
      expect(declarations[0]).toContain(tool);
    }
  }

  expect(results).toHaveLength(1);
  expect(results[0]?.isError, JSON.stringify(results[0]?.result)).toBe(false);

  expect(results[0]?.result).toMatchObject({
    details: { directory: join(directory, '.tau', 'slices', 'first') },
  });
});
