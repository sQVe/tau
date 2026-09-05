import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DefaultResourceLoader, SettingsManager } from '@mariozechner/pi-coding-agent';
import { expect, it } from 'vitest';

it('loads the Tau package through Pi with its commit tool, command, guard, and skill', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-package-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));

  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [packageRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();

    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(1);
    expect(extensions[0]?.tools.has('commit')).toBe(true);
    expect(extensions[0]?.commands.has('commit')).toBe(true);
    expect(extensions[0]?.handlers.get('tool_call')).toHaveLength(1);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(['commit']);
    expect(loader.getSkills().diagnostics).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
