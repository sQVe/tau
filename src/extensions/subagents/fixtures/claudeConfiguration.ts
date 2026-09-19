import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ConfigurationOptions {
  defaultMode?: string;
  skipPrompt?: boolean;
  plugins?: Record<string, boolean>;
  installed?: boolean;
  harness?: string;
  version?: string;
}

export const claudeConfigurationFixture = (root: string, options: ConfigurationOptions = {}) => {
  const configuration = join(root, 'claude');
  const install = join(configuration, 'plugins', 'cache', 'market', 'cc-safety-net', '2.4.1');

  mkdirSync(join(install, 'hooks'), { recursive: true });
  mkdirSync(join(install, 'dist', 'bin'), { recursive: true });
  writeFileSync(
    join(install, 'dist', 'bin', 'cc-safety-net.js'),
    `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked' } }));`,
  );
  writeFileSync(
    join(install, 'hooks', 'hooks.json'),
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
  writeFileSync(
    join(configuration, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins:
        options.installed === false
          ? {}
          : { 'cc-safety-net@market': [{ scope: 'user', installPath: install }] },
    }),
  );

  writeFileSync(
    join(configuration, 'settings.json'),
    JSON.stringify({
      permissions: { defaultMode: options.defaultMode ?? 'bypassPermissions' },
      skipDangerousModePermissionPrompt: options.skipPrompt ?? true,
      enabledPlugins: options.plugins ?? { 'cc-safety-net@market': true },
    }),
  );

  const binary = join(root, 'bin');
  mkdirSync(binary, { recursive: true });
  const executable = join(binary, 'claude');
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf "${options.version ?? '2.1.276 (Claude Code)'}\\n"\n`,
  );
  chmodSync(executable, 0o755);

  const agents = join(root, '.pi', 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(agents, 'claude-worker.md'),
    `---\nname: claude-worker\nrole: editing\ncli: ${options.harness ?? 'claude'}\nthinking: low\n---\nComplete only the assigned change.\n`,
  );
  writeFileSync(
    join(agents, 'claude-scout.md'),
    '---\nname: claude-scout\nrole: investigation\ncli: claude\nthinking: low\n---\nInvestigate only the assigned question.\n',
  );

  return { configuration, install, executable, binary };
};
