import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../tests/extensionApi.js';
import { writeStommeProject } from '../../tests/stommeProjectHarness.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import instructionsExtension from './instructions.js';

it('reads the snapshot of the run that starts, so bundled language rules end when a project appears', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_ROLE', undefined);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const directory = temporaryDirectory(onTestFinished, 'tau-instructions-order-');
  const sessionManager = SessionManager.inMemory();

  const api = fakeExtensionApi({
    appendEntry: vi.fn<ExtensionAPI['appendEntry']>((type, data) => {
      sessionManager.appendCustomEntry(type, data);
    }),
  });

  const context = {
    cwd: directory,
    sessionManager,
    isIdle: () => false,
    ui: { notify: vi.fn<ExtensionContext['ui']['notify']>() },
  } as unknown as ExtensionContext;

  await instructionsExtension(api.pi);

  const emit = async (name: string, event: unknown) => {
    for (const handler of api.handlers.get(name) ?? []) {
      await handler(event as never, context);
    }
  };

  const run = async () => {
    const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools: [] } };

    await emit('before_agent_start', event);

    return event.systemPromptOptions.appendSystemPrompt;
  };

  await emit('session_start', { reason: 'startup' });
  await run();
  await emit('tool_call', { toolName: 'read', input: { path: 'main.ts' } });

  const bundled = await run();

  expect(bundled).toContain('languages/typescript/guide.md');

  await writeStommeProject(directory, { language: 'rust' });

  const project = await run();

  expect(project).toContain('docs/stomme/languages/rust/guide.md');
  expect(project).not.toContain('languages/typescript/guide.md');
});
