"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Loader2 } from "lucide-react";

const TYPES = [
  { value: "FTI_EXPOSURE", label: "FTI Exposure" },
  { value: "PII_BREACH", label: "PII Breach" },
  { value: "UNAUTHORIZED_ACCESS", label: "Unauthorized Access" },
  { value: "SYSTEM_COMPROMISE", label: "System Compromise" },
  { value: "POLICY_VIOLATION", label: "Policy Violation" },
];

const SEVERITIES = [
  { value: "CRITICAL", label: "Critical" },
  { value: "HIGH", label: "High" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
];

export function NewIncidentDialog() {
  const router = useRouter();
  const [showDialog, setShowDialog] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("FTI_EXPOSURE");
  const [severity, setSeverity] = useState("HIGH");
  const [affectedSystems, setAffectedSystems] = useState("");
  const [dateOccurred, setDateOccurred] = useState("");

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setType("FTI_EXPOSURE");
    setSeverity("HIGH");
    setAffectedSystems("");
    setDateOccurred("");
    setError(null);
  };

  const handleClose = () => {
    setShowDialog(false);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError("Title is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          type,
          severity,
          affectedSystems: affectedSystems
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          dateOccurred: dateOccurred ? new Date(dateOccurred).toISOString() : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create incident");
      }

      handleClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setShowDialog(true)}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] rounded-lg transition-colors"
      >
        <Plus className="w-4 h-4" />
        New Incident
      </button>

      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={handleClose}
          />
          <div className="relative bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-[var(--sky-border)]">
              <h2 className="text-lg font-semibold text-white">
                Report New Incident
              </h2>
              <button
                onClick={handleClose}
                className="p-1 rounded-lg text-[var(--sky-text-muted)] hover:text-gray-600 dark:hover:text-gray-200 hover:bg-[var(--sky-surface-overlay)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1">
                  Title <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Brief description of the incident"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface)] text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Detailed description of what happened..."
                  rows={4}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface)] text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)] resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1">
                    Type
                  </label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface)] text-white focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
                  >
                    {TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1">
                    Severity
                  </label>
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface)] text-white focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1">
                  Affected Systems
                </label>
                <input
                  type="text"
                  value={affectedSystems}
                  onChange={(e) => setAffectedSystems(e.target.value)}
                  placeholder="Comma-separated list (e.g., Email Server, VPN)"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface)] text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--sky-text-secondary)] mb-1">
                  Date Occurred
                </label>
                <input
                  type="datetime-local"
                  value={dateOccurred}
                  onChange={(e) => setDateOccurred(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface)] text-white focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)]"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-[var(--sky-border)]">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 text-sm font-medium text-[var(--sky-text-secondary)] hover:bg-[var(--sky-surface-overlay)] rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    "Create Incident"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

