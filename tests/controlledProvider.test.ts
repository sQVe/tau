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

it('reports why the controlled provider could not read its assignment', async () => {
  vi.resetModules();

  vi.doMock(import('node:child_process'), () => ({
    execFileSync: () => {
      throw new Error('hc missing');
    },
  }));

  vi.stubEnv('HC_SESSION', 'session');
  vi.stubEnv('HC_TERMINAL_ID', 'worker');

  try {
    await expect(
      import('../src/extensions/subagents/fixtures/controlledProvider.js'),
    ).rejects.toThrow('could not read the fixture assignment: hc missing');
  } finally {
    vi.doUnmock(import('node:child_process'));
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});
