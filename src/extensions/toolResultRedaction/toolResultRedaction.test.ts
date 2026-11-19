import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import toolResultRedaction from './toolResultRedaction.js';

it('withholds the result when redaction throws', () => {
  vi.stubEnv('TAU_FAKE_API_KEY', 'fake-secret-value-1234567890');
  const { pi, handler } = fakeExtensionApi();

  toolResultRedaction(pi);

  const details = {
    get broken(): string {
      throw new Error('unreadable');
    },
  };

  const result = handler('tool_result')(
    { content: [{ type: 'text', text: 'output' }], details, structuredContent: undefined },
    {} as never,
  );

  expect(result).toEqual({
    content: [
      { type: 'text', text: 'Tau withheld this tool result because secret redaction failed.' },
    ],
    details: {},
    isError: true,
  });

  vi.unstubAllEnvs();
});
