import { readFile } from 'node:fs/promises';

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

export default async function writingExtension(pi: ExtensionAPI) {
  const instructionsPath = new URL('./instructions.md', import.meta.url);
  const instructions = await readFile(instructionsPath, 'utf8');

  if (!instructions.trim()) {
    throw new Error(`Writing instructions are empty: ${instructionsPath.href}`);
  }

  pi.on('before_agent_start', (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
  }));
}
