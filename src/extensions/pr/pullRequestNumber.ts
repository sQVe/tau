export const requirePullRequestNumber = (action: string, pr: number | undefined): number => {
  if (pr === undefined) {
    throw new Error(`${action} needs pr.`);
  }

  if (!Number.isSafeInteger(pr)) {
    throw new TypeError(`pr must be an integer, not ${pr}.`);
  }

  if (pr < 1) {
    throw new Error(`pr must be 1 or more, not ${pr}.`);
  }

  return pr;
};
