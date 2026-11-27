import { expect, it } from 'vitest';

import { blockedOutputReason, nohupClose } from './bashGuardCommands.js';
import { registeredTauApi } from './tauRegistration.js';

it('registers the detached output guard through the Tau registration', async () => {
  const fake = await registeredTauApi('lead');
  const event = { toolName: 'bash', input: { command: nohupClose } };

  const results = await Promise.allSettled(
    (fake.handlers.get('tool_call') ?? []).map(async (handler) =>
      handler(event as never, {} as never),
    ),
  );

  const reasons = results.flatMap((result) =>
    result.status === 'fulfilled' ? [blockedOutputReason(result.value)] : [],
  );

  // Only the bash guard answers with the log-file instruction, so one such result proves that this
  // handler blocked the call.
  expect(reasons.filter((reason) => reason !== undefined)).toHaveLength(1);
});
