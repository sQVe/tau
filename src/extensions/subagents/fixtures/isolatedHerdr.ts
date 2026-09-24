import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { onTestFinished } from 'vitest';

import { runClient } from '../cancellation.js';

export const isolatedHerdr = async (
  configuration = '',
  // Panes inherit this server's environment, so harness fixtures must be bound here.
  extraEnvironment: Record<string, string> = {},
) => {
  const root = mkdtempSync(join(tmpdir(), 'tau-herdr-worker-'));
  // Never inherit the active socket, caller IDs, or user configuration.
  const environment = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    HERDR_CONFIG_PATH: join(root, 'herdr.toml'),
    PI_CODING_AGENT_DIR: join(root, 'agent'),
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    ...extraEnvironment,
  };
  mkdirSync(environment.PI_CODING_AGENT_DIR);
  writeFileSync(
    environment.HERDR_CONFIG_PATH,
    `onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n${configuration}`,
  );
  const server = spawn('herdr', ['--session', 'tau-worker-test', 'server'], {
    env: environment,
    stdio: 'ignore',
  });
  const exited = once(server, 'exit');
  onTestFinished(async () => {
    server.kill('SIGTERM');
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  const readyDeadline = performance.now() + 10_000;

  while (!existsSync(join(root, 'config', 'herdr', 'sessions', 'tau-worker-test', 'herdr.sock'))) {
    if (performance.now() > readyDeadline) {
      throw new Error('Isolated herdr did not start.');
    }

    await delay(25);
  }

  const client = (argumentsList: string[], budget = 5000, signal?: AbortSignal) =>
    runClient('herdr', ['--session', 'tau-worker-test', ...argumentsList], budget, {
      signal,
      environment,
    });

  return { root, environment, client };
};
