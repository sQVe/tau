import { expect, it, vi } from 'vitest';

it('refuses to load the controlled provider without HC_SESSION', async () => {
  vi.resetModules();
  vi.stubEnv('HC_SESSION', '');
  vi.stubEnv('HC_TERMINAL_ID', 'worker');

  try {
    await expect(
      import('../src/extensions/subagents/fixtures/controlledProvider.js'),
    ).rejects.toThrow('HC_SESSION');
  } finally {
    vi.unstubAllEnvs();
  }
});
