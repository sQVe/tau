import { randomBytes } from 'node:crypto';

import { kill, readCurrentTerminal, run, wait } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { decideWaitOutcome } from './reviewDecisions.js';

export interface ReviewTerminalRequest {
  stagingDirectory: string;
  space: string;
}

export interface ReviewExitRequest {
  address: string;
  recordDirectory: string;
  timeoutSeconds: number;
}

export const reviewWaitTimeoutSeconds = 30;

const suffixByteCount = 4;

const messageWaitLimit = 5;

export class TuicrExitTimeoutError extends Error {
  override name = 'TuicrExitTimeoutError';
}

export const reviewSpace = async (runtime: HcRuntime): Promise<string | undefined> => {
  const terminal = await readCurrentTerminal(runtime);
  const labels = terminal?.labels;

  return labels?.['herdr.space'];
};

export const openReviewTerminal = async (
  runtime: HcRuntime,
  request: ReviewTerminalRequest,
): Promise<string> => {
  const suffix = randomBytes(suffixByteCount).toString('hex');

  const terminal = await run(runtime, {
    argv: ['tuicr', '--file', request.stagingDirectory],
    cwd: request.stagingDirectory,
    labels: { 'herdr.space': request.space },
    name: `draft-review-${suffix}`,
    background: true,
    notify: false,
  });

  return terminal.address;
};

export const waitForReviewExit = async (
  runtime: HcRuntime,
  request: ReviewExitRequest,
): Promise<void> => {
  for (let waitCount = 0; waitCount < messageWaitLimit; waitCount += 1) {
    // oxlint-disable-next-line no-await-in-loop -- A message means waiting again, so each wait follows the last.
    const result = await wait(runtime, request.address, { timeout: request.timeoutSeconds });
    const outcome = decideWaitOutcome(result);

    if (outcome === 'finished') {
      return;
    }

    if (outcome !== 'message') {
      break;
    }
  }

  throw new TuicrExitTimeoutError(
    `tuicr did not exit, so no comment was deleted. The review record is ${request.recordDirectory}. Quit tuicr, then call collect again.`,
  );
};

export const endReviewTerminal = async (runtime: HcRuntime, address: string): Promise<void> => {
  await kill(runtime, address);
};
