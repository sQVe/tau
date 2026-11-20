export interface TabRenameFacts {
  role: string;
  detail: string | undefined;
  currentName: string;
  lastWrittenName: string | undefined;
}

const maximumTabNameLength = 24;

const normalized = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ').trim();

const highSurrogateStart = 0xd800;
const highSurrogateEnd = 0xdbff;

const isHighSurrogate = (codeUnit: number): boolean =>
  codeUnit >= highSurrogateStart && codeUnit <= highSurrogateEnd;

const sliceAtCharacterBoundary = (text: string, end: number): string => {
  const sliced = text.slice(0, end);
  const lastCodeUnit = sliced.charCodeAt(sliced.length - 1);

  return isHighSurrogate(lastCodeUnit) ? sliced.slice(0, -1) : sliced;
};

const fitDetail = (detail: string, budget: number): string => {
  if (detail.length <= budget) {
    return detail;
  }

  const lastSpace = detail.lastIndexOf(' ', budget);
  const end = lastSpace > 0 ? lastSpace : budget;

  return sliceAtCharacterBoundary(detail, end);
};

export const tabName = (role: string, detail?: string): string => {
  const fittedRole = sliceAtCharacterBoundary(normalized(role), maximumTabNameLength).trimEnd();
  const fittedDetail = normalized(detail ?? '');
  const budget = maximumTabNameLength - fittedRole.length - 2;

  if (fittedDetail === '' || budget < 1) {
    return fittedRole;
  }

  return `${fittedRole}: ${fitDetail(fittedDetail, budget)}`;
};

const isDefaultName = (name: string): boolean => {
  const trimmed = name.trim();

  return trimmed === '' || /^\d+$/u.test(trimmed);
};

export const tabRenameDecision = (facts: TabRenameFacts): string | undefined => {
  const target = tabName(facts.role, facts.detail);
  const currentName = facts.currentName;
  const eligible = isDefaultName(currentName) || currentName === facts.lastWrittenName;

  if (!eligible || currentName === target) {
    return undefined;
  }

  return target;
};
