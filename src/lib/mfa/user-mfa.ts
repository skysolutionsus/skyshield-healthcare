import { db } from "@/lib/db";
import { decryptMfaSecret } from "@/lib/mfa/secrets";
import { findMatchingRecoveryCode } from "@/lib/mfa/recovery-codes";
import { matchTotpCounter, normalizeTotpCode } from "@/lib/mfa/totp";

export type SuccessfulMfaVerification =
  | { ok: true; method: "totp"; totpCounter: number }
  | { ok: true; method: "recovery_code"; recoveryCodeId: string };
export type MfaVerificationResult = SuccessfulMfaVerification | { ok: false };

export async function verifyMfaForUser({
  userId,
  secretEncrypted,
  token,
}: {
  userId: string;
  secretEncrypted: string | null;
  token: string;
}): Promise<MfaVerificationResult> {
  const trimmedToken = token.trim();
  if (!trimmedToken) return { ok: false };

  if (secretEncrypted && /^\d{6}$/.test(normalizeTotpCode(trimmedToken))) {
    const secret = decryptMfaSecret(secretEncrypted);
    const totpCounter = matchTotpCounter({ secret, code: trimmedToken });
    if (totpCounter !== null) {
      return { ok: true, method: "totp", totpCounter };
    }
  }

  const recoveryCodes = await db.mfaRecoveryCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true, usedAt: true },
  });
  const matchingCodeId = await findMatchingRecoveryCode({
    token: trimmedToken,
    recoveryCodes,
  });

  if (!matchingCodeId) {
    return { ok: false };
  }

  // Verification deliberately does not consume the row. The caller must use
  // recoveryCodeId in a conditional usedAt:null update inside the same
  // transaction as the protected action and its audit record.
  return {
    ok: true,
    method: "recovery_code",
    recoveryCodeId: matchingCodeId,
  };
}
