/** Return true only for a valid TOTP moving factor newer than the last one used. */
export function isFreshTotpCounter(
  lastUsedCounter: number | null,
  candidateCounter: number
): boolean {
  return (
    Number.isSafeInteger(candidateCounter) &&
    candidateCounter >= 0 &&
    (lastUsedCounter === null || candidateCounter > lastUsedCounter)
  );
}

/**
 * A conditional `usedAt: null` database update is a successful single-use
 * recovery-code consumption only when it changes exactly one row.
 */
export function recoveryCodeConsumptionSucceeded(updatedRows: number): boolean {
  return updatedRows === 1;
}
