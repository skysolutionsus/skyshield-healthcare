"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";

interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  lastUsedAt: string | null;
  recoveryCodesRemaining: number;
}

interface MfaSettingsProps {
  status: MfaStatus;
}

interface SetupState {
  secret: string;
  qrCodeDataUrl: string;
  expiresAt: string;
}

export function MfaSettings({ status }: MfaSettingsProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(status.enabled);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [challengeCode, setChallengeCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  const enabledAt = status.enabledAt
    ? formatDateTime(status.enabledAt)
    : "Not recorded";
  const lastUsedAt = status.lastUsedAt
    ? formatDateTime(status.lastUsedAt)
    : "Not recorded";

  async function postMfaAction<T>(
    action: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    setError("");
    setMessage("");
    setLoadingAction(action);

    try {
      const response = await fetch("/api/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "MFA request failed");
      }

      return data as T;
    } finally {
      setLoadingAction(null);
    }
  }

  async function startSetup() {
    try {
      const data = await postMfaAction<SetupState>("start");
      setSetup(data);
      setSetupCode("");
      setRecoveryCodes([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start setup");
    }
  }

  async function verifySetup() {
    try {
      const data = await postMfaAction<{ recoveryCodes: string[] }>("verify", {
        code: setupCode,
      });
      setEnabled(true);
      setSetup(null);
      setSetupCode("");
      setRecoveryCodes(data.recoveryCodes);
      setMessage("MFA enabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to verify setup");
    }
  }

  async function disableMfa() {
    try {
      await postMfaAction("disable", { code: challengeCode });
      setEnabled(false);
      setChallengeCode("");
      setRecoveryCodes([]);
      setMessage("MFA disabled");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to disable MFA");
    }
  }

  async function regenerateRecoveryCodes() {
    try {
      const data = await postMfaAction<{ recoveryCodes: string[] }>(
        "regenerate_recovery_codes",
        { code: challengeCode }
      );
      setChallengeCode("");
      setRecoveryCodes(data.recoveryCodes);
      setMessage("Recovery codes regenerated");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to regenerate codes"
      );
    }
  }

  async function copyRecoveryCodes() {
    await navigator.clipboard.writeText(recoveryCodes.join("\n"));
    setMessage("Recovery codes copied");
  }

  function finishRecoveryCodes() {
    setRecoveryCodes([]);
    router.refresh();
  }

  return (
    <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6 mb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-[var(--sky-light)]" />
          </div>
          <div>
            <h2 className="font-semibold text-white">
              Multi-factor authentication
            </h2>
            <p className="text-sm text-[var(--sky-text-secondary)] mt-1">
              Authenticator app and one-time recovery codes
            </p>
          </div>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-xs font-medium ${
            enabled
              ? "bg-emerald-500/15 text-emerald-300"
              : "bg-amber-500/15 text-amber-300"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              enabled ? "bg-emerald-400" : "bg-amber-400"
            }`}
          />
          {enabled ? "Enabled" : "Not enabled"}
        </span>
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}
      {message && (
        <div className="mt-5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {message}
        </div>
      )}

      {recoveryCodes.length > 0 ? (
        <div className="mt-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {recoveryCodes.map((code) => (
              <code
                key={code}
                className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-sm text-white tracking-wide"
              >
                {code}
              </code>
            ))}
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={copyRecoveryCodes}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--sky-border)] px-4 py-2 text-sm font-medium text-white hover:bg-white/5 transition-colors"
            >
              <Copy className="w-4 h-4" />
              Copy codes
            </button>
            <button
              type="button"
              onClick={finishRecoveryCodes}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--sky-royal)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--sky-blue)] transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" />
              Done
            </button>
          </div>
        </div>
      ) : setup ? (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-6">
          <div className="rounded-xl bg-white p-3 w-fit">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={setup.qrCodeDataUrl}
              alt="Authenticator QR code"
              className="w-[220px] h-[220px]"
            />
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-2">
                Setup key
              </label>
              <code className="block rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-sm text-white break-all">
                {setup.secret}
              </code>
            </div>

            <div>
              <label
                htmlFor="mfa-setup-code"
                className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-2"
              >
                Verification code
              </label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--sky-text-muted)]" />
                <input
                  id="mfa-setup-code"
                  value={setupCode}
                  onChange={(event) => setSetupCode(event.target.value)}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  className="w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] pl-10 pr-3 py-2 text-sm text-white placeholder:text-[var(--sky-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
                  placeholder="123456"
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={verifySetup}
                disabled={loadingAction === "verify"}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--sky-royal)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--sky-blue)] disabled:opacity-50 transition-colors"
              >
                {loadingAction === "verify" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4" />
                )}
                Enable MFA
              </button>
              <button
                type="button"
                onClick={() => setSetup(null)}
                className="inline-flex items-center justify-center rounded-lg border border-[var(--sky-border)] px-4 py-2 text-sm font-medium text-white hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : enabled ? (
        <div className="mt-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="rounded-lg bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] px-3 py-3">
              <p className="text-[var(--sky-text-muted)]">Enabled</p>
              <p className="text-white mt-1">{enabledAt}</p>
            </div>
            <div className="rounded-lg bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] px-3 py-3">
              <p className="text-[var(--sky-text-muted)]">Last used</p>
              <p className="text-white mt-1">{lastUsedAt}</p>
            </div>
            <div className="rounded-lg bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] px-3 py-3">
              <p className="text-[var(--sky-text-muted)]">Recovery codes</p>
              <p className="text-white mt-1">
                {status.recoveryCodesRemaining} remaining
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3">
            <div>
              <label
                htmlFor="mfa-challenge-code"
                className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-2"
              >
                Current MFA or recovery code
              </label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--sky-text-muted)]" />
                <input
                  id="mfa-challenge-code"
                  value={challengeCode}
                  onChange={(event) => setChallengeCode(event.target.value)}
                  autoComplete="one-time-code"
                  inputMode="text"
                  className="w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] pl-10 pr-3 py-2 text-sm text-white placeholder:text-[var(--sky-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
                  placeholder="123456 or recovery code"
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row lg:self-end gap-3">
              <button
                type="button"
                onClick={regenerateRecoveryCodes}
                disabled={loadingAction === "regenerate_recovery_codes"}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--sky-border)] px-4 py-2 text-sm font-medium text-white hover:bg-white/5 disabled:opacity-50 transition-colors"
              >
                {loadingAction === "regenerate_recovery_codes" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                New codes
              </button>
              <button
                type="button"
                onClick={disableMfa}
                disabled={loadingAction === "disable"}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
              >
                {loadingAction === "disable" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ShieldOff className="w-4 h-4" />
                )}
                Disable
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-6">
          <button
            type="button"
            onClick={startSetup}
            disabled={loadingAction === "start"}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--sky-royal)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--sky-blue)] disabled:opacity-50 transition-colors"
          >
            {loadingAction === "start" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Smartphone className="w-4 h-4" />
            )}
            Set up authenticator
          </button>
        </div>
      )}
    </div>
  );
}
