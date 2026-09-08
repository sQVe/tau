import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const requireRegisteredTools = (
  pi: ExtensionAPI,
  packageName: string,
  required: readonly string[],
) => {
  pi.on('session_start', () => {
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const missing = required.filter((name) => !registered.has(name));

    if (missing.length === 0) return;

    const names = missing.map((name) => `"${name}"`).join(', ');
    const subject = missing.length === 1 ? `Tool ${names} is` : `Tools ${names} are`;

    throw new Error(
      `${subject} not registered. Either the bundled package ${packageName} failed to load and Tau needs reinstalling, or that package's configuration turned it off or renamed it.`,
    );
  });
};
