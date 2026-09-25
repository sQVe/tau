import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';

import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createBoundSession } from './piSession.js';

vi.setConfig({ testTimeout: 60_000 });

it.for(['shared', 'override', 'invalid', 'missing', 'authentication', 'provider'] as const)(
  'runs web answer mode through Pi with delegate selection: %s',
  async (scenario, { onTestFinished }) => {
    const directory = await mkdtemp(join(tmpdir(), 'tau-web-answer-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const agentDirectory = join(directory, 'agent');
    await mkdir(agentDirectory);
    isolateWebAccessConfig(agentDirectory, onTestFinished);
    // Tau's shared setting takes precedence over the upstream persistent answer setting.
    await writeFile(
      join(agentDirectory, 'web-search.json'),
      JSON.stringify({
        fetch: { answerProvider: 'ignored', answerModel: 'ignored' },
        fetchRouting: { providers: ['http'] },
        // Only this isolated fixture server may bypass the package's private-address guard.
        ssrf: { allowRanges: ['127.0.0.1/32'] },
      }),
    );
    vi.stubEnv('TAU_DELEGATE_MODEL', 'web-delegate/reader');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

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
    const delegate = fauxProvider({ provider: 'web-delegate', models: [{ id: 'reader' }] });
    const override = fauxProvider({ provider: 'web-override', models: [{ id: 'reader' }] });

    // Faux completions need no credentials, but the web package requires an API key.
    for (const provider of [delegate, override]) {
      provider.provider.auth.apiKey!.resolve = async () => ({ auth: { apiKey: 'test' } });
    }

    const { session } = await createBoundSession(onTestFinished, {
      cwd: directory,
      agentDirectory,
      providers: [sessionModel, delegate, override],
      tools: ['fetch_content', 'get_search_content', 'web_search'],
      extensionPaths: [
        resolve(import.meta.dirname, '../src/extensions/webAccess/index.ts'),
        resolve(import.meta.dirname, '../node_modules/pi-web-access/index.ts'),
      ],
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
    });

    if (scenario === 'invalid' || scenario === 'missing') {
      vi.stubEnv('TAU_DELEGATE_MODEL', scenario === 'invalid' ? 'invalid' : 'missing/model');
    } else if (scenario === 'override') {
      vi.stubEnv('TAU_DELEGATE_MODEL', 'invalid');
    } else if (scenario === 'authentication') {
      const authentication = vi
        .spyOn(delegate.provider.auth.apiKey!, 'resolve')
        .mockRejectedValue(new Error('credentials expired'));
      onTestFinished(() => {
        authentication.mockRestore();
      });
    }

    const call = {
      url: `http://127.0.0.1:${address.port}/policy`,
      mode: 'answer',
      prompt: 'How many times are requests retried?',
      ...(scenario === 'override' ? { answerModel: 'web-override/reader' } : {}),
    };
    sessionModel.setResponses([
      fauxAssistantMessage([fauxToolCall('fetch_content', call)]),
      fauxAssistantMessage('Done.'),
    ]);
    delegate.setResponses([
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
    const success = scenario === 'shared' || scenario === 'override';

    const expected = success
      ? 'requests retry once'
      : {
          invalid: 'invalid delegate model',
          missing: 'model not found',
          authentication: 'no api key available',
          provider: 'provider unavailable',
        }[scenario];

    expect(text.toLowerCase()).toContain(expected);
    expect(session.model?.provider).toBe('web-session');
    expect(sessionModel.state.callCount).toBe(2);
    expect(override.state.callCount).toBe(scenario === 'override' ? 1 : 0);
    expect(delegate.state.callCount).toBe(['shared', 'provider'].includes(scenario) ? 1 : 0);
  },
);
