import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import modelFallbackExtension from './modelFallback.js';

const startupReportKey = Symbol.for('tau.modelFallback.startupReported');

const fakeRegistration = () => {
  const ids: string[] = [];

  const registerVirtualModel = vi.fn<ExtensionAPI['registerVirtualModel']>((model) => {
    ids.push(model.id);
  });

  return { ids, pi: fakeExtensionApi({ registerVirtualModel }).pi };
};

it('reports a refused entry once per process', async ({ onTestFinished }) => {
  Reflect.deleteProperty(globalThis, startupReportKey);

  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-fallback-startup-');
  const configPath = join(agentDirectory, 'tau.json');
  const valid = { primary: 'a/primary', fallback: 'b/fallback', fallbackAtRetry: 5 };

  writeFileSync(
    configPath,
    JSON.stringify({
      fallbackModels: {
        'deepseek-flash': valid,
        bad: { ...valid, fallbackAtRetry: 0 },
      },
    }),
  );

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  onTestFinished(() => {
    Reflect.deleteProperty(globalThis, startupReportKey);
    write.mockRestore();
    vi.unstubAllEnvs();
  });

  const first = fakeRegistration();

  modelFallbackExtension(first.pi);

  vi.resetModules();

  const { default: reloaded } = await import('./modelFallback.js');
  const second = fakeRegistration();

  reloaded(second.pi);

  expect(first.ids).toEqual(['deepseek-flash']);
  expect(second.ids).toEqual(['deepseek-flash']);

  expect(write.mock.calls.map(([text]) => text).join('')).toBe(
    `Error: Invalid Tau config ${configPath}: fallbackModels.bad.fallbackAtRetry 0 must be a whole number of at least 1.\n`,
  );
});
