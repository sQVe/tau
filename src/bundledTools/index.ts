import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const requireRegisteredTools = (
  pi: ExtensionAPI,
  packageName: string,
  requiredToolNames: readonly string[],
) => {
  // A worker registers only its profile's tools and checks those itself.
  // oxlint-disable-next-line node/no-process-env -- The parent marks a worker process with its task record.
  if (process.env.TAU_WORKER_RECORD != null && process.env.TAU_WORKER_RECORD !== '') {
    return;
  }

  pi.on('session_start', () => {
    const registeredToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const missingToolNames = requiredToolNames.filter((name) => !registeredToolNames.has(name));

    if (missingToolNames.length === 0) {
      return;
    }

    const quotedToolNames = missingToolNames.map((name) => `"${name}"`).join(', ');

    const subject =
      missingToolNames.length === 1 ? `Tool ${quotedToolNames} is` : `Tools ${quotedToolNames} are`;

    throw new Error(
      `${subject} not registered. The bundled package ${packageName} either failed to load or has configuration that disables or renames tools. Reinstall Tau if the package failed to load.`,
    );
  });
};
