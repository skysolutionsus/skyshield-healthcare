"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  ShieldAlert,
  UserPlus,
} from "lucide-react";

export function UserManagement({ orgId: _orgId }: { orgId: string }) {
  const router = useRouter();
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("COMPUTER_SECURITY_REVIEW");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setCopied(false);

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, action: "invite" }),
      });

      const data = await res.json();
      if (res.ok) {
        const token = typeof data.token === "string" ? data.token : "";
        if (!token) throw new Error("Invitation token was not returned");
        const registrationUrl = `${window.location.origin}/register#token=${encodeURIComponent(token)}`;
        setInviteUrl(registrationUrl);
        setEmail("");
        setRole("COMPUTER_SECURITY_REVIEW");
      } else {
        setError(data.error || "Failed to create invitation link");
      }
    } catch (inviteError) {
      setError(
        inviteError instanceof Error
          ? inviteError.message
          : "Failed to create invitation link"
      );
    } finally {
      setLoading(false);
    }
  }

  async function copyInviteUrl() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setError("");
    } catch {
      setError("Could not copy automatically. Select and copy the link manually.");
    }
  }

  function finishInvite() {
    setInviteUrl("");
    setCopied(false);
    setShowInvite(false);
    router.refresh();
  }

  return (
    <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6 mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-semibold text-white">Invite Team Member</h2>
          <p className="mt-1 text-xs text-[var(--sky-text-muted)]">
            Create a one-time registration link for an approved user.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowInvite(!showInvite)}
          className="flex items-center gap-2 px-3 py-2 bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] text-white text-sm font-medium rounded-lg transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          {showInvite ? "Close" : "Invite User"}
        </button>
      </div>

      {showInvite && inviteUrl && (
        <div className="space-y-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-amber-400/10 p-2 text-amber-300">
              <ShieldAlert className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-amber-100">
                Copy this invitation link now
              </h3>
              <p className="mt-1 text-xs leading-5 text-amber-100/70">
                The secret link is displayed only once and cannot be recovered.
                It was not emailed. Share it through an approved secure channel.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-[var(--sky-border)] bg-[var(--sky-navy)] px-3 py-2.5 text-xs leading-5 text-[var(--sky-white)]">
              {inviteUrl}
            </code>
            <button
              type="button"
              onClick={copyInviteUrl}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-amber-300 px-4 py-2.5 text-sm font-semibold text-[var(--sky-navy)] transition-colors hover:bg-amber-200"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <a
              href={inviteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-300 hover:text-sky-200"
            >
              Preview registration page
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              onClick={finishInvite}
              className="rounded-lg border border-[var(--sky-border)] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/5"
            >
              I saved the link
            </button>
          </div>
        </div>
      )}

      {showInvite && !inviteUrl && (
        <form onSubmit={handleInvite} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label
                htmlFor="invite-email"
                className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1"
              >
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="off"
                disabled={loading}
                placeholder="colleague@agency.gov"
                className="w-full px-3 py-2 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)] disabled:opacity-60"
              />
            </div>
            <div>
              <label
                htmlFor="invite-role"
                className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1"
              >
                Role
              </label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                disabled={loading}
                className="w-full px-3 py-2 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)] disabled:opacity-60"
              >
                <option value="COMPUTER_SECURITY_REVIEW">Computer Security Review</option>
                <option value="COMPLIANCE_OFFICER">Compliance Officer</option>
                <option value="AUDITOR">Auditor</option>
                <option value="VIEWER">Viewer</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-sky-400/15 bg-sky-400/[0.05] px-3 py-2.5 text-xs leading-5 text-[var(--sky-text-secondary)]">
            <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-300" />
            No email is sent by SkyShield. You will receive a single-use link to
            copy and deliver securely. Creating another link for this email
            invalidates the earlier one.
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading ? "Creating link..." : "Create invitation link"}
          </button>
        </form>
      )}

      {showInvite && inviteUrl && error && (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
