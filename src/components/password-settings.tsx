"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { KeyRound, Loader2, Lock, ShieldCheck } from "lucide-react";
import { strongPasswordValidationError } from "@/lib/password-policy";

const inputClassName =
  "w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] py-2.5 pl-10 pr-3 text-sm text-white placeholder:text-[var(--sky-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)] disabled:opacity-50";

export function PasswordSettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmation) {
      setError("New passwords do not match.");
      return;
    }
    const passwordError = strongPasswordValidationError(newPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || "Unable to change password.");
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      await signOut({ callbackUrl: "/login" });
    } catch (passwordChangeError) {
      setError(
        passwordChangeError instanceof Error
          ? passwordChangeError.message
          : "Unable to change password."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mb-8 rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)]">
          <KeyRound className="h-5 w-5 text-[var(--sky-light)]" />
        </div>
        <div>
          <h2 className="font-semibold text-white">Password</h2>
          <p className="mt-1 text-sm text-[var(--sky-text-secondary)]">
            Current MFA verification is required. Changing your password signs
            every session out.
          </p>
        </div>
      </div>

      <form onSubmit={changePassword} className="mt-6 space-y-4">
        <div>
          <label htmlFor="current-password" className="mb-2 block text-sm font-medium text-[var(--sky-text-secondary)]">
            Current password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sky-text-muted)]" />
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              autoComplete="current-password"
              disabled={loading}
              className={inputClassName}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="new-password" className="mb-2 block text-sm font-medium text-[var(--sky-text-secondary)]">
              New password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sky-text-muted)]" />
              <input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
                minLength={16}
                autoComplete="new-password"
                disabled={loading}
                className={inputClassName}
              />
            </div>
          </div>
          <div>
            <label htmlFor="confirm-new-password" className="mb-2 block text-sm font-medium text-[var(--sky-text-secondary)]">
              Confirm new password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sky-text-muted)]" />
              <input
                id="confirm-new-password"
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                minLength={16}
                autoComplete="new-password"
                disabled={loading}
                className={inputClassName}
              />
            </div>
          </div>
        </div>

        <p className="text-xs leading-5 text-[var(--sky-text-muted)]">
          Use 16–72 UTF-8 bytes with upper- and lowercase letters, a number, and a symbol.
        </p>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--sky-royal)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--sky-blue)] disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {loading ? "Changing password…" : "Change password and sign out"}
        </button>
      </form>
    </section>
  );
}
