/**
 * pi-web-access reads its configuration from PI_CODING_AGENT_DIR, falling back to
 * ~/.pi/web-search.json. Use a test directory so personal settings cannot change
 * which tools register or prevent the extension from loading.
 */
export const isolateWebAccessConfig = (
  agentDirectory: string,
  registerCleanup: (restore: () => void) => void,
) => {
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = agentDirectory;

  registerCleanup(() => {
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
  });
};
