import { readFile } from 'node:fs/promises';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default async function writingExtension(extensionApi: ExtensionAPI) {
  const instructionsPath = new URL('./instructions.md', import.meta.url);
  const instructions = await readFile(instructionsPath, 'utf8');

  const trimmedInstructions = instructions.trim();

  if (!trimmedInstructions) {
    throw new Error(`Writing instructions are empty: ${instructionsPath.href}`);
  }

  extensionApi.on('before_agent_start', (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
  }));
}
