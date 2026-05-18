"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, Loader2, RotateCcw, ShieldOff } from "lucide-react";

interface AdminUserActionsProps {
  userId: string;
  currentUserId: string;
  userName: string;
  userEmail: string;
}

export function AdminUserActions({
  userId,
  currentUserId,
  userName,
  userEmail,
}: AdminUserActionsProps) {
  const router = useRouter();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const isSelf = userId === currentUserId;

  async function runAction(action: "reset_password" | "reset_mfa") {
    if (isSelf) return;
    const confirmed = window.confirm(
      action === "reset_password"
        ? `Reset password for ${userName}? A temporary password will be generated.`
        : `Reset MFA for ${userName}? They will need to enroll again.`
    );

    if (!confirmed) {
      return;
    }

    setLoadingAction(action);
    setMessage("");
    setError("");
    setTemporaryPassword("");

    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, userId }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "User action failed");
      }

      if (action === "reset_password") {
        setTemporaryPassword(data.temporaryPassword || "");
        setMessage(`Password reset for ${userEmail}`);
      } else {
        setMessage(`MFA reset for ${userEmail}`);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "User action failed");
    } finally {
      setLoadingAction(null);
    }
  }

  async function copyTemporaryPassword() {
    await navigator.clipboard.writeText(temporaryPassword);
    setMessage("Temporary password copied");
  }

  if (isSelf) {
    return (
      <span className="text-xs text-[var(--sky-text-muted)]">Current user</span>
    );
  }

  return (
    <div className="min-w-[260px] space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => runAction("reset_password")}
          disabled={loadingAction !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--sky-border)] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/5 disabled:opacity-50 transition-colors"
        >
          {loadingAction === "reset_password" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <KeyRound className="w-3.5 h-3.5" />
          )}
          Reset password
        </button>
        <button
          type="button"
          onClick={() => runAction("reset_mfa")}
          disabled={loadingAction !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/10 disabled:opacity-50 transition-colors"
        >
          {loadingAction === "reset_mfa" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ShieldOff className="w-3.5 h-3.5" />
          )}
          Reset TOTP
        </button>
      </div>

      {temporaryPassword && (
        <div className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-2">
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-white break-all">
              {temporaryPassword}
            </code>
            <button
              type="button"
              onClick={copyTemporaryPassword}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--sky-text-secondary)] hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Copy temporary password"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {message && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-300">
          <RotateCcw className="w-3 h-3" />
          {message}
        </p>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
