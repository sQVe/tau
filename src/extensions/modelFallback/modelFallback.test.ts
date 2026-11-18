import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import modelFallbackExtension from './modelFallback.js';

it('writes the refused entry to stderr in list mode and registers the valid model', ({
  onTestFinished,
}) => {
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

  const argv = process.argv;
  const registered: string[] = [];

  const registerVirtualModel = vi.fn<ExtensionAPI['registerVirtualModel']>((model) => {
    registered.push(model.id);
  });

  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  process.argv = [...argv, '--list-models'];

  onTestFinished(() => {
    process.argv = argv;
    write.mockRestore();
    vi.unstubAllEnvs();
  });

  modelFallbackExtension(fakeExtensionApi({ registerVirtualModel }).pi);

  expect(registered).toEqual(['deepseek-flash']);

  expect(write.mock.calls.map(([text]) => text).join('')).toBe(
    `Error: Invalid Tau config ${configPath}: fallbackModels.bad.fallbackAtRetry 0 must be a whole number of at least 1.\n`,
  );
});
