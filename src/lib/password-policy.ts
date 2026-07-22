/**
 * Return a user-facing validation error for passwords that are unsuitable for
 * bcrypt-backed interactive accounts. Bcrypt only considers the first 72
 * bytes, so accepting a longer value would make two visibly different
 * passwords authenticate as the same secret.
 */
export function strongPasswordValidationError(value: unknown): string | null {
  if (typeof value !== "string") return "Password is required.";
  if (value.length < 16) {
    return "Password must be at least 16 characters.";
  }
  if (new TextEncoder().encode(value).byteLength > 72) {
    return "Password must be no more than 72 UTF-8 bytes.";
  }
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value)) {
    return "Password must include uppercase and lowercase letters.";
  }
  if (!/\d/.test(value)) {
    return "Password must include a number.";
  }
  if (!/[^A-Za-z0-9]/.test(value)) {
    return "Password must include a symbol.";
  }
  return null;
}
