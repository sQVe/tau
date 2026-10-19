// A worker loads skillTools again from disk and checks that Pi registered every tool it lists. Pi
// registers only the tools the parent passed, so a parent with an older copy starts workers that fail.
export const skillToolsRefusal = (
  loadedSource: string,
  currentSource: string,
): string | undefined => {
  if (currentSource === loadedSource) {
    return undefined;
  }

  return 'Tau changed on disk since this Pi session loaded it, so the worker would expect other tools. Run /reload, then launch again.';
};
