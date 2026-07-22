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
  const [resetLink, setResetLink] = useState("");
  const [resetExpiresAt, setResetExpiresAt] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const isSelf = userId === currentUserId;

  async function runAction(action: "create_password_reset" | "reset_mfa") {
    if (isSelf) return;
    const confirmed = window.confirm(
      action === "create_password_reset"
        ? `Create a one-time password reset link for ${userName}? You must deliver it through an approved secure channel.`
        : `Reset MFA for ${userName}? They will need to enroll again.`
    );

    if (!confirmed) {
      return;
    }

    setLoadingAction(action);
    setMessage("");
    setError("");
    setResetLink("");
    setResetExpiresAt("");

    try {
      const response = await fetch("/api/users", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, userId }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "User action failed");
      }

      if (action === "create_password_reset") {
        const token = typeof data.token === "string" ? data.token : "";
        if (!token) throw new Error("Reset link was not returned");
        setResetLink(
          `${window.location.origin}/reset-password#token=${encodeURIComponent(token)}`
        );
        setResetExpiresAt(
          typeof data.expiresAt === "string" ? data.expiresAt : ""
        );
        setMessage(
          `Reset link created for ${userEmail}. It was not emailed or otherwise delivered.`
        );
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

  async function copyResetLink() {
    try {
      await navigator.clipboard.writeText(resetLink);
      setError("");
      setMessage(
        "Reset link copied. Deliver it through an approved secure channel; SkyShield does not email it."
      );
    } catch {
      setMessage("");
      setError(
        "Clipboard access failed. Select and copy the displayed link manually before clearing it."
      );
    }
  }

  function clearResetLink() {
    setResetLink("");
    setResetExpiresAt("");
    setMessage("");
    setError("");
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
          onClick={() => runAction("create_password_reset")}
          disabled={loadingAction !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--sky-border)] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/5 disabled:opacity-50 transition-colors"
        >
          {loadingAction === "create_password_reset" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <KeyRound className="w-3.5 h-3.5" />
          )}
          Create reset link
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

      {resetLink && (
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3">
          <p className="mb-2 text-xs leading-5 text-amber-100/80">
            This bearer link is shown only from this response. Copy it now and
            protect it like a temporary credential.
            {resetExpiresAt
              ? ` It expires ${new Date(resetExpiresAt).toLocaleString()}.`
              : ""}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-white break-all">
              {resetLink}
            </code>
            <button
              type="button"
              onClick={copyResetLink}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--sky-text-secondary)] hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Copy password reset link"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={clearResetLink}
            className="mt-3 text-xs font-medium text-amber-200 underline-offset-2 hover:underline"
          >
            I saved the link — clear it
          </button>
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
