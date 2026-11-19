const workerNameSuffixLength = 8;
const workerNameSuffix = new RegExp(`-([0-9a-f]{${workerNameSuffixLength}})$`);

export const workerName = (profile: string, assignmentId: string): string =>
  `${profile}-${assignmentId.replaceAll('-', '').slice(0, workerNameSuffixLength)}`;

export const assignmentPrefixFromName = (name: string | null | undefined): string | undefined =>
  workerNameSuffix.exec(name ?? '')?.[1];
