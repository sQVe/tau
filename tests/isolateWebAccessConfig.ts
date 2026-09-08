/**
 * pi-web-access reads its config from PI_CODING_AGENT_DIR, falling back to the real
 * ~/.pi/web-search.json. Point it at a test directory so a developer's own settings cannot
 * change which tools register, and an unparsable config cannot fail the extension load.
 */
export const isolateWebAccessConfig = (
  agentDir: string,
  registerCleanup: (restore: () => void) => void,
) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  registerCleanup(() => {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
};
