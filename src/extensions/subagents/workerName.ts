const workerNameSuffixLength = 8;
const workerNameSuffix = new RegExp(`-([0-9a-f]{${workerNameSuffixLength}})$`);

export const assignmentShortId = (assignmentId: string): string =>
  assignmentId.replaceAll('-', '').slice(0, workerNameSuffixLength);

export const workerName = (profile: string, assignmentId: string): string =>
  `${profile}-${assignmentShortId(assignmentId)}`;

export const assignmentPrefixFromName = (name: string | null | undefined): string | undefined =>
  workerNameSuffix.exec(name ?? '')?.[1];
