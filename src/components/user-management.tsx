"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Loader2 } from "lucide-react";

export function UserManagement({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("VIEWER");
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
        setRole("VIEWER");
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
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6 mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-gray-900 dark:text-white">
          Invite Team Member
        </h2>
        <button
          onClick={() => setShowInvite(!showInvite)}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          Invite User
        </button>
      </div>

      {showInvite && (
        <form onSubmit={handleInvite} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="colleague@agency.gov"
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Role
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="VIEWER">Viewer</option>
                <option value="AUDITOR">Auditor</option>
                <option value="COMPLIANCE_OFFICER">Compliance Officer</option>
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
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Send Invitation
          </button>
        </form>
      )}
    </div>
  );
}
