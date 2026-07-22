const MIN_AUTH_SECRET_LENGTH = 32;
const WEAK_SECRET_PATTERN =
  /change.?me|placeholder|replace|example|password|default|development|skyshield|your.?secret/i;

export function runtimeAuthSecretError(
  environment: NodeJS.ProcessEnv
): string | null {
  const configured = environment.AUTH_SECRET || environment.NEXTAUTH_SECRET;
  if (!configured) {
    return "AUTH_SECRET or NEXTAUTH_SECRET must be explicitly configured.";
  }
  if (configured !== configured.trim()) {
    return "The authentication secret must not have leading or trailing whitespace.";
  }
  if (configured.length < MIN_AUTH_SECRET_LENGTH) {
    return `The authentication secret must contain at least ${MIN_AUTH_SECRET_LENGTH} characters.`;
  }
  if (WEAK_SECRET_PATTERN.test(configured)) {
    return "The authentication secret resembles a known placeholder or weak default.";
  }
  if (new Set(configured).size < 8) {
    return "The authentication secret does not contain enough character diversity.";
  }
  return null;
}
