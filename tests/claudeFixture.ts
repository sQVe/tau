import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

const requestSchema = Type.Object({
  model: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.Object({ name: Type.Optional(Type.String()) }))),
});

export const fixtureApiKey = 'tau-fixture-key-not-a-secret';
export const fixtureModel = 'claude-tau-fixture';

const safetyPackage = fileURLToPath(new URL('../node_modules/cc-safety-net', import.meta.url));

// Use the real safety plugin so integration tests exercise its hook, not a simulated denial.
export const claudeConfiguration = (root: string, cwd: string) => {
  const configuration = join(root, 'claude-config');
  const plugin = join(configuration, 'plugins', 'cache', 'fixture', 'cc-safety-net', '2.4.1');

  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  cpSync(join(safetyPackage, 'dist'), join(plugin, 'dist'), { recursive: true });
  writeFileSync(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'cc-safety-net', version: '2.4.1', description: 'Fixture install' }),
  );
  writeFileSync(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: `node "\${CLAUDE_PLUGIN_ROOT}/dist/bin/cc-safety-net.js" hook --coding-cli`,
              },
            ],
          },
        ],
      },
    }),
  );

  const marketplace = join(configuration, 'plugins', 'marketplaces', 'fixture');
  mkdirSync(join(marketplace, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(marketplace, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'fixture',
      owner: { name: 'tau' },
      plugins: [{ name: 'cc-safety-net', description: 'Fixture install', source: plugin }],
    }),
  );
  writeFileSync(
    join(configuration, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({
      fixture: {
        source: { source: 'directory', path: marketplace },
        installLocation: marketplace,
      },
    }),
  );
  writeFileSync(
    join(configuration, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'cc-safety-net@fixture': [
          { scope: 'user', installPath: plugin, version: '2.4.1', installedAt: '2026-01-01' },
        ],
      },
    }),
  );

  writeFileSync(
    join(configuration, 'settings.json'),
    JSON.stringify({
      permissions: { defaultMode: 'bypassPermissions' },
      skipDangerousModePermissionPrompt: true,
      enabledPlugins: { 'cc-safety-net@fixture': true },
      env: { DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' },
    }),
  );
  writeFileSync(
    join(configuration, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [fixtureApiKey.slice(-20)], rejected: [] },
      projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [], history: [] } },
    }),
  );

  return { configuration, plugin };
};

interface ScriptedCall {
  tool: string;
  input: Record<string, unknown>;
}

export type Script = (request: {
  model: string;
  conversation: string;
  tools: string[];
  index: number;
}) => ScriptedCall | string;

const event = (name: string, body: unknown) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`;

const stream = (index: number, call: ScriptedCall | string) => {
  const block =
    typeof call === 'string'
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: `tau-fixture-${index}`, name: call.tool, input: {} };
  const delta =
    typeof call === 'string'
      ? { type: 'text_delta', text: call }
      : { type: 'input_json_delta', partial_json: JSON.stringify(call.input) };

  return [
    event('message_start', {
      type: 'message_start',
      message: {
        id: `message-${index}`,
        type: 'message',
        role: 'assistant',
        model: fixtureModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: typeof call === 'string' ? 'end_turn' : 'tool_use',
        stop_sequence: null,
      },
      usage: { output_tokens: 7 },
    }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
};

// Serve scripted Anthropic responses locally without real credentials.
export const scriptedClaudeApi = async (script: Script) => {
  const requests: { path: string; model?: string | undefined }[] = [];
  const failures: string[] = [];
  // Claude also asks for session titles with no tools. Only tool-bearing turns advance the script.
  let turns = 0;
  let offered: string[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      if (!path.startsWith('/v1/messages') || path.includes('count_tokens')) {
        requests.push({ path });
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{"error":"unsupported fixture endpoint"}');

        return;
      }

      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const parsed = Value.Check(requestSchema, body) ? body : { model: '', tools: [] };
        requests.push({ path, model: parsed.model });

        const tools = (parsed.tools ?? []).flatMap((tool) => (tool.name ? [tool.name] : []));
        const turnIndex = turns;
        if (tools.length) {
          offered = tools;
          turns += 1;
        }

        const data = stream(
          requests.length - 1,
          tools.length
            ? script({
                model: parsed.model ?? '',
                conversation: JSON.stringify(body),
                tools,
                index: turnIndex,
              })
            : 'Fixture acknowledgement.',
        );

        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Content-Length': String(Buffer.byteLength(data)),
        });
        response.end(data);
      } catch (error) {
        failures.push(String(error));
        response.writeHead(400).end();
      }
    });
  });

  await new Promise<void>((resolved) => {
    server.listen(0, '127.0.0.1', resolved);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    failures,
    offeredTools: () => offered,
    close: () =>
      new Promise<void>((resolved) => {
        server.close(() => {
          resolved();
        });
      }),
  };
};
