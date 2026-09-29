import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI, ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { cutBashOutput } from './bashOutputCap.js';

// mkdtemp creates the directory readable only by its owner, outside the worktree under test.
const saveFullOutput = async (text: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-bash-'));
  const path = join(directory, 'output.log');

  await writeFile(path, text, { mode: 0o600 });

  return path;
};

// A failing test run prints its failure details before its summary, where a cut would hide them.
const capBashOutput = async (event: ToolResultEvent) => {
  if (event.toolName !== 'bash' || event.isError) {
    return undefined;
  }

  const [part, ...rest] = event.content;

  if (part?.type !== 'text' || rest.length > 0) {
    return undefined;
  }

  const text = part.text;
  const cutOutput = cutBashOutput(text);

  if (cutOutput === undefined) {
    return undefined;
  }

  const { head, tail, cut } = cutOutput;
  const path = await saveFullOutput(text);
  const marker = `[${cut} of ${text.length} characters cut. Command exited with code 0. Full output: ${path}]`;

  return { content: [{ type: 'text' as const, text: `${head}\n\n${marker}\n\n${tail}` }] };
};

export default function workerBashGuard(pi: ExtensionAPI): void {
  pi.on('tool_call', (event) => {
    if (event.toolName !== 'bash') {
      return undefined;
    }

    const command = event.input.command;

    if (typeof command !== 'string' || command.trim().length > 0) {
      return undefined;
    }

    return {
      block: true,
      reason: 'Empty bash command rejected. Send the complete command and continue your task.',
    };
  });

  pi.on('tool_result', capBashOutput);
}
