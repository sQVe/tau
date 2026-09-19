import { spawn } from 'node:child_process';

import { channelScriptPath } from '../claude.js';

export interface HookAnswer {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Drive the real worker-side channel script, so tests exercise the transport Claude uses.
export const channelHook = (
  socketPath: string,
  event: string,
  payload: Record<string, unknown>,
  claudePid = process.pid,
): Promise<HookAnswer> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [channelScriptPath(), 'hook', event, socketPath], {
      // oxlint-disable-next-line node/no-process-env -- Keep the fixture environment separate from user Claude settings.
      env: { PATH: process.env.PATH ?? '', CLAUDE_PID: String(claudePid) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(JSON.stringify(payload));
  });

export const channelCall = (
  socketPath: string,
  name: string,
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [channelScriptPath(), 'mcp', socketPath], {
      // oxlint-disable-next-line node/no-process-env -- Keep the fixture environment separate from user Claude settings.
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffered = '';

    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();

      // A chunk can end mid-frame; keep the remainder for the next one.
      for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) {
          continue;
        }

        const message: unknown = JSON.parse(line);
        if (message && typeof message === 'object' && 'id' in message && message.id === 2) {
          child.kill();
          resolve(message);

          return;
        }
      }
    });
    child.once('error', reject);
    child.once('close', (code) => {
      reject(new Error(`Channel process closed before its response, with code ${String(code)}.`));
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        ...(name === 'tools/list'
          ? { method: 'tools/list', params: {} }
          : { method: 'tools/call', params: { name, arguments: input } }),
      })}\n`,
    );
  });
