"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Loader2 } from "lucide-react";

export function UserManagement({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("COMPUTER_SECURITY_REVIEW");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, action: "invite" }),
      });

      const data = await res.json();
      if (res.ok) {
        setMessage("Invitation sent successfully");
        setEmail("");
        setRole("COMPUTER_SECURITY_REVIEW");
        router.refresh();
      } else {
        setMessage(data.error || "Failed to send invitation");
      }
    } catch {
      setMessage("Failed to send invitation");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6 mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-white">
          Invite Team Member
        </h2>
        <button
          onClick={() => setShowInvite(!showInvite)}
          className="flex items-center gap-2 px-3 py-2 bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] text-white text-sm font-medium rounded-lg transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          Invite User
        </button>
      </div>

      {showInvite && (
        <form onSubmit={handleInvite} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="colleague@agency.gov"
                className="w-full px-3 py-2 bg-gray-50 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1">
                Role
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
              >
                <option value="COMPUTER_SECURITY_REVIEW">Computer Security Review</option>
                <option value="COMPLIANCE_OFFICER">Compliance Officer</option>
                <option value="AUDITOR">Auditor</option>
                <option value="VIEWER">Viewer</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
          </div>

          {message && (
            <p
              className={`text-sm ${message.includes("success") ? "text-green-600" : "text-red-600"}`}
            >
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Send Invitation
          </button>
        </form>
      )}
    </div>
  );
}
