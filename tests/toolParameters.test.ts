import { expect, it } from 'vitest';

import tauExtension from '../src/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

// Providers and MCP bridges refuse a tool whose parameters are not an object at the top, such as a
// union of objects.
it('gives every registered tool an object schema at the top of its parameters', async () => {
  const fake = fakeExtensionApi();

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
