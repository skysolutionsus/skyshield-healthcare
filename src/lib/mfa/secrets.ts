import crypto from "crypto";

const CIPHER = "aes-256-gcm";
const VERSION = "v1";

export function encryptMfaSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptMfaSecret(encrypted: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = encrypted.split(":");
  if (
    version !== VERSION ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue
  ) {
    throw new Error("Invalid encrypted MFA secret");
  }

  const decipher = crypto.createDecipheriv(
    CIPHER,
    getEncryptionKey(),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function getEncryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET or NEXTAUTH_SECRET is required for MFA");
  }

  return crypto.createHash("sha256").update(secret).digest();
}
