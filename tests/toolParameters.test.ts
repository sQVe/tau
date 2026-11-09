import { expect, it, onTestFinished } from 'vitest';

import { releaseRegistration } from '../src/inbox/inbox.js';
import tauExtension from '../src/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

// Providers and MCP bridges refuse a tool whose parameters are not an object at the top, such as a
// union of objects.
it('gives every registered tool an object schema at the top of its parameters', async () => {
  const fake = fakeExtensionApi();

  // No session starts, so no session_shutdown releases the inbox that loading Tau claims.
  onTestFinished(releaseRegistration);
  await tauExtension(fake.pi);

  expect(fake.tools.size).toBeGreaterThan(0);

  for (const tool of fake.tools.values()) {
    const { type } = tool.parameters as { type?: unknown };

    expect({ tool: tool.name, type }).toEqual({
      tool: tool.name,
      type: 'object',
    });
  }
});
