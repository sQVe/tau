import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createBoundSession } from './piSession.js';

vi.setConfig({ testTimeout: 60_000 });

let directory: string;
let agentDirectory: string;

// pi-web-access keeps the config path from its first load in this process, so every scenario shares one.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tau-web-answer-'));
  agentDirectory = join(directory, 'agent');
  await mkdir(agentDirectory);

  isolateWebAccessConfig(agentDirectory, (restore) => {
    afterAll(restore);
  });

  // Without a passed answerModel, pi-web-access answers with its own configured model.
  await writeFile(
    join(agentDirectory, 'web-search.json'),
    JSON.stringify({
      fetch: { answerProvider: 'web-configured', answerModel: 'reader' },
      fetchRouting: { providers: ['http'] },
      // Only this isolated fixture server may bypass the package's private-address guard.
      ssrf: { allowRanges: ['127.0.0.1/32'] },
    }),
  );
});

afterAll(() => rm(directory, { recursive: true, force: true }));

const passedModels = {
  configured: undefined,
  authentication: undefined,
  provider: undefined,
  override: 'web-override/reader',
  disallowed: 'web-override/reader',
  invalid: 'invalid',
  missing: 'missing/model',
};

it.for(Object.keys(passedModels) as (keyof typeof passedModels)[])(
  'runs web answer mode through Pi with answer model selection: %s',
  async (scenario, { onTestFinished }) => {
    if (scenario === 'disallowed') {
      const tauConfig = join(agentDirectory, 'tau.json');

      await writeFile(tauConfig, JSON.stringify({ allowedModels: ['web-configured/reader'] }));
      onTestFinished(() => rm(tauConfig, { force: true }));
    }

    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });

      const paragraphs =
        '<p>Requests retry once after a transient failure. Authentication failures are never retried.</p>'.repeat(
          8,
        );

      response.end(
        `<html><body><article><h1>Retry policy</h1>${paragraphs}</article></body></html>`,
      );
    });

    onTestFinished(
      () =>
        new Promise<void>((resolveClose, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolveClose();
            }
          });

          server.closeAllConnections();
        }),
    );

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();

    if (address == null || typeof address === 'string') {
      throw new Error('Missing fixture server address');
    }

    const sessionModel = fauxProvider({ provider: 'web-session' });
    const configured = fauxProvider({ provider: 'web-configured', models: [{ id: 'reader' }] });
    const override = fauxProvider({ provider: 'web-override', models: [{ id: 'reader' }] });

    // Faux completions need no credentials, but the web package requires an API key.
    for (const provider of [configured, override]) {
      provider.provider.auth.apiKey!.resolve = async () => ({ auth: { apiKey: 'test' } });
    }

    const { session } = await createBoundSession(onTestFinished, {
      cwd: directory,
      agentDirectory,
      providers: [sessionModel, configured, override],
      tools: ['fetch_content', 'get_search_content', 'web_search'],
      extensionPaths: [
        resolve(import.meta.dirname, '../src/extensions/webAccess/index.ts'),
        resolve(import.meta.dirname, '../node_modules/pi-web-access/dist/index.js'),
      ],
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
    });

    if (scenario === 'authentication') {
      const authentication = vi
        .spyOn(configured.provider.auth.apiKey!, 'resolve')
        .mockRejectedValue(new Error('credentials expired'));

      onTestFinished(() => {
        authentication.mockRestore();
      });
    }

    const call = {
      url: `http://127.0.0.1:${address.port}/policy`,
      mode: 'answer',
      prompt: 'How many times are requests retried?',
      ...(passedModels[scenario] === undefined ? {} : { answerModel: passedModels[scenario] }),
    };

    sessionModel.setResponses([
      fauxAssistantMessage([fauxToolCall('fetch_content', call)]),
      fauxAssistantMessage('Done.'),
    ]);

    configured.setResponses([
      scenario === 'provider'
        ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider unavailable' })
        : fauxAssistantMessage('Requests retry once.'),
    ]);

    override.setResponses([fauxAssistantMessage('Override: requests retry once.')]);

    await session.prompt('Read the retry policy.');

    const entry = session.sessionManager
      .getEntries()
      .find(
        (candidate) =>
          candidate.type === 'message' &&
          candidate.message.role === 'toolResult' &&
          candidate.message.toolName === 'fetch_content',
      );

    if (entry?.type !== 'message' || entry.message.role !== 'toolResult') {
      throw new Error('Missing fetch result');
    }

    const text = JSON.stringify(entry.message.content);
    const success = scenario === 'configured' || scenario === 'override';

    const expected = success
      ? 'requests retry once'
      : {
          disallowed: 'web-override/reader is not allowed',
          invalid: 'invalid model',
          missing: 'not found',
          authentication: 'no api key available',
          provider: 'provider unavailable',
        }[scenario];

    expect(text.toLowerCase()).toContain(expected);
    expect(session.model?.provider).toBe('web-session');
    expect(sessionModel.state.callCount).toBe(2);
    expect(override.state.callCount).toBe(scenario === 'override' ? 1 : 0);
    expect(configured.state.callCount).toBe(['configured', 'provider'].includes(scenario) ? 1 : 0);
  },
);
