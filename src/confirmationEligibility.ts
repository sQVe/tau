interface ConfirmationFacts {
  isWorker: boolean;
  hasUI: boolean;
}

export const confirmationRefusal = (
  facts: ConfirmationFacts,
  action: string,
): string | undefined => {
  if (facts.isWorker) {
    return `${action} needs the user's confirmation, which a worker cannot give. Nothing was written. Ask the parent session to make this write.`;
  }

  if (!facts.hasUI) {
    return `${action} needs the user's confirmation, which a session without UI cannot give. Nothing was written. Use a session with UI.`;
  }

  return undefined;
};
