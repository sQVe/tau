export interface TabRenameFacts {
  role: string;
  detail: string | undefined;
  currentName: string;
  lastWrittenName: string | undefined;
}

const maximumTabNameLength = 24;

const normalized = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ').trim();

const fitDetail = (detail: string, budget: number): string => {
  if (detail.length <= budget) {
    return detail;
  }

  const cut = detail.slice(0, budget + 1);
  const lastSpace = cut.lastIndexOf(' ');

  if (lastSpace > 0) {
    return cut.slice(0, lastSpace);
  }

  return detail.slice(0, budget);
};

export const tabName = (role: string, detail?: string): string => {
  const fittedRole = normalized(role).slice(0, maximumTabNameLength).trimEnd();
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

  if (facts.currentName === target) {
    return undefined;
  }

  if (isDefaultName(facts.currentName)) {
    return target;
  }

  if (facts.lastWrittenName !== undefined && facts.currentName === facts.lastWrittenName) {
    return target;
  }

  return undefined;
};
