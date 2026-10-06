import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createCodeReviewTool } from '../src/extensions/codeReview/tool.js';
import type { CodeReviewInput } from '../src/extensions/codeReview/tool.js';
import type { ReviewTarget } from '../src/reviewCapture/reviewCapture.js';
import { noUiContext } from './toolContext.js';

const runCodeReview = async (root: string, input: CodeReviewInput) => {
  const result = await createCodeReviewTool().execute(
    'call',
    input,
    undefined,
    undefined,
    noUiContext(root),
  );

  return result.details;
};

export const createSavedReview = async (root: string, target: ReviewTarget): Promise<string> => {
  const { directory } = (await runCodeReview(root, { action: 'prepare' })) as { directory: string };

  await writeFile(join(directory, 'input.md'), '# Review input\n\n## Capture\n');
  await runCodeReview(root, { action: 'capture', directory, target });
  await runCodeReview(root, { action: 'freshness', directory });

  return directory;
};
