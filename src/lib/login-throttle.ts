export const LOGIN_FAILURE_THRESHOLD = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export type LoginThrottleState = {
  failedLoginAttempts: number;
  lastFailedLoginAt: Date | null;
  loginLockedUntil: Date | null;
};

export type NextLoginFailureState = LoginThrottleState & {
  newlyLocked: boolean;
};

export function isLoginLocked(
  state: Pick<LoginThrottleState, "loginLockedUntil">,
  now: Date
): boolean {
  return Boolean(
    state.loginLockedUntil && state.loginLockedUntil.getTime() > now.getTime()
  );
}

/**
 * Deterministically advance bounded account-lockout state. The failure counter
 * resets after a quiet window or an expired lock and never grows without bound.
 */
export function nextLoginFailureState(
  current: LoginThrottleState,
  now: Date
): NextLoginFailureState {
  const priorLockExpired = Boolean(
    current.loginLockedUntil &&
      current.loginLockedUntil.getTime() <= now.getTime()
  );
  const failureWindowExpired =
    !current.lastFailedLoginAt ||
    now.getTime() - current.lastFailedLoginAt.getTime() >
      LOGIN_FAILURE_WINDOW_MS;
  const baseAttempts =
    priorLockExpired || failureWindowExpired
      ? 0
      : Math.max(0, Math.min(current.failedLoginAttempts, LOGIN_FAILURE_THRESHOLD));
  const failedLoginAttempts = Math.min(
    baseAttempts + 1,
    LOGIN_FAILURE_THRESHOLD
  );
  const newlyLocked = failedLoginAttempts >= LOGIN_FAILURE_THRESHOLD;

  return {
    failedLoginAttempts,
    lastFailedLoginAt: now,
    loginLockedUntil: newlyLocked
      ? new Date(now.getTime() + LOGIN_LOCKOUT_DURATION_MS)
      : null,
    newlyLocked,
  };
}

export const clearedLoginThrottleState: LoginThrottleState = {
  failedLoginAttempts: 0,
  lastFailedLoginAt: null,
  loginLockedUntil: null,
};
