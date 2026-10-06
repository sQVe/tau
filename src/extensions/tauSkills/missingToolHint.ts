export const missingToolHint = (
  errorText: string,
  skillTools: Readonly<Record<string, readonly string[]>>,
): string | undefined => {
  const missingTools = new Set(
    [...errorText.matchAll(/\btools\.([\w]+) does not exist\b/g)].map((match) => match[1]),
  );

  for (const [skill, tools] of Object.entries(skillTools)) {
    const tool = tools.find((name) => missingTools.has(name));

    if (tool !== undefined) {
      return `The ${skill} skill uses ${tool}, but this session did not register it. Start a new Pi session that allows ${tool}: list it in --tools if you pass --tools, and leave it out of --exclude-tools.`;
    }
  }

  return undefined;
};
