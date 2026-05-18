import { db } from "@/lib/db";
import { decryptMfaSecret } from "@/lib/mfa/secrets";
import { findMatchingRecoveryCode } from "@/lib/mfa/recovery-codes";
import { normalizeTotpCode, verifyTotpCode } from "@/lib/mfa/totp";

export type MfaVerificationMethod = "totp" | "recovery_code";

export async function verifyMfaForUser({
  userId,
  secretEncrypted,
  token,
  consumeRecoveryCode = true,
}: {
  userId: string;
  secretEncrypted: string | null;
  token: string;
  consumeRecoveryCode?: boolean;
}): Promise<{ ok: boolean; method?: MfaVerificationMethod }> {
  const trimmedToken = token.trim();
  if (!trimmedToken) return { ok: false };

  if (secretEncrypted && /^\d{6}$/.test(normalizeTotpCode(trimmedToken))) {
    const secret = decryptMfaSecret(secretEncrypted);
    if (verifyTotpCode({ secret, code: trimmedToken })) {
      return { ok: true, method: "totp" };
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

  if (consumeRecoveryCode) {
    await db.mfaRecoveryCode.update({
      where: { id: matchingCodeId },
      data: { usedAt: new Date() },
    });
  }

  return { ok: true, method: "recovery_code" };
}
