import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { unverifiableReason } from '../src/extensions/bashGuard/detachedOutputDecision.js';
import { blockedOutputReason, nestedScript, nohupClose } from './bashGuardCommands.js';
import { registeredTauApi } from './tauRegistration.js';

const bashCall = (command: string): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'tool-call-1',
  toolName: 'bash',
  input: { command },
});

const reasonsFor = async (event: ToolCallEvent): Promise<(string | undefined)[]> => {
  const fake = await registeredTauApi('lead');

  const results = await Promise.allSettled(
    (fake.handlers.get('tool_call') ?? []).map(async (handler) =>
      handler(event as never, {} as never),
    ),
  );

  return results.flatMap((result) =>
    result.status === 'fulfilled' ? [blockedOutputReason(result.value)] : [],
  );
};

it('registers the detached output guard through the Tau registration', async () => {
  const reasons = await reasonsFor(bashCall(nohupClose));

  // Only the bash guard answers with the log-file instruction, so one such result proves that this
  // handler blocked the call.
  expect(reasons.filter((reason) => reason !== undefined)).toHaveLength(1);
});

it('registers the guard that reports a script chain it cannot inspect', async () => {
  const reasons = await reasonsFor(bashCall(nestedScript(6)));

  expect(reasons).toContain(unverifiableReason);
});

it('accepts only a reason the guard itself produces', () => {
  expect(
    blockedOutputReason({ block: true, reason: 'write a log such as /tmp/<name>.log first' }),
  ).toBeUndefined();
});
