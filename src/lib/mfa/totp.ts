import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(crypto.randomBytes(byteLength));
}

export function buildTotpUri({
  issuer,
  accountName,
  secret,
}: {
  issuer: string;
  accountName: string;
  secret: string;
}) {
  const label = `${issuer}:${accountName}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: TOTP_DIGITS.toString(),
    period: TOTP_PERIOD_SECONDS.toString(),
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function normalizeTotpCode(code: string): string {
  return code.replace(/\s/g, "");
}

export function verifyTotpCode({
  secret,
  code,
  now = Date.now(),
  window = 1,
}: {
  secret: string;
  code: string;
  now?: number;
  window?: number;
}): boolean {
  const normalized = normalizeTotpCode(code);
  if (!/^\d{6}$/.test(normalized)) return false;

  const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -window; offset <= window; offset++) {
    const candidateCounter = counter + offset;
    if (candidateCounter < 0) continue;

    const candidate = generateTotpCode(secret, candidateCounter);
    if (timingSafeEqual(candidate, normalized)) {
      return true;
    }
  }

  return false;
}

function generateTotpCode(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto
    .createHmac("sha1", key)
    .update(counterBuffer)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(secret: string): Buffer {
  const normalized = secret.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error("Invalid TOTP secret");
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}
