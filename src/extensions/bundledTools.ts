import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const requireRegisteredTools = (
  pi: ExtensionAPI,
  packageName: string,
  required: readonly string[],
) => {
  pi.on('session_start', () => {
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const missing = required.filter((name) => !registered.has(name));

    if (missing.length > 0) {
      throw new Error(
        `Tools ${missing.map((name) => `"${name}"`).join(', ')} are not registered. Either the bundled package ${packageName} failed to load and Tau needs reinstalling, or these tools are turned off in its configuration.`,
      );
    }
  });
};
