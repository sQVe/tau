export type HeaderLayout = { kind: 'labelOnly' } | { kind: 'withCounter'; ruleWidth: number };

export const headerLayout = (
  width: number,
  labelWidth: number,
  counterWidth: number,
): HeaderLayout => {
  if (width < labelWidth + counterWidth) {
    return { kind: 'labelOnly' };
  }

  return { kind: 'withCounter', ruleWidth: Math.max(0, width - labelWidth - counterWidth - 1) };
};
