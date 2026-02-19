"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Loader2,
  MessageSquare,
  FileText,
  ChevronDown,
} from "lucide-react";

const STATUS_WORKFLOW: Record<string, string[]> = {
  OPEN: ["INVESTIGATING"],
  INVESTIGATING: ["REMEDIATION", "RESOLVED"],
  REMEDIATION: ["RESOLVED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
};

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  INVESTIGATING: "Investigating",
  REMEDIATION: "Remediation",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

const STATUS_BUTTON_STYLES: Record<string, string> = {
  INVESTIGATING:
    "bg-amber-600 hover:bg-amber-700 text-white",
  REMEDIATION:
    "bg-purple-600 hover:bg-purple-700 text-white",
  RESOLVED:
    "bg-green-600 hover:bg-green-700 text-white",
  CLOSED:
    "bg-gray-600 hover:bg-gray-700 text-white",
};

interface IncidentDetailActionsProps {
  incidentId: string;
  currentStatus: string;
  currentSeverity: string;
  remediationPlan: string;
}

export function IncidentDetailActions({
  incidentId,
  currentStatus,
  currentSeverity,
  remediationPlan,
}: IncidentDetailActionsProps) {
  const router = useRouter();
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Note form
  const [noteText, setNoteText] = useState("");
  const [submittingNote, setSubmittingNote] = useState(false);

  // Remediation plan form
  const [showRemediationEdit, setShowRemediationEdit] = useState(false);
  const [remediationText, setRemediationText] = useState(remediationPlan);
  const [savingRemediation, setSavingRemediation] = useState(false);

  const nextStatuses = STATUS_WORKFLOW[currentStatus] || [];

  const handleStatusChange = async (newStatus: string) => {
    setError(null);
    setSuccess(null);
    setUpdating(true);

    try {
      const res = await fetch(`/api/incidents/${incidentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update status");
      }

      setSuccess(`Status updated to ${STATUS_LABELS[newStatus]}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setUpdating(false);
    }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteText.trim()) return;

    setError(null);
    setSuccess(null);
    setSubmittingNote(true);

    try {
      const res = await fetch(`/api/incidents/${incidentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addNote: noteText.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add note");
      }

      setNoteText("");
      setSuccess("Note added successfully");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmittingNote(false);
    }
  };

  const handleSaveRemediation = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSavingRemediation(true);

    try {
      const res = await fetch(`/api/incidents/${incidentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remediationPlan: remediationText.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update remediation plan");
      }

      setShowRemediationEdit(false);
      setSuccess("Remediation plan updated");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSavingRemediation(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Status Change */}
      {nextStatuses.length > 0 && (
        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold text-white mb-3">
            Update Status
          </h3>
          <div className="space-y-2">
            {nextStatuses.map((status) => (
              <button
                key={status}
                onClick={() => handleStatusChange(status)}
                disabled={updating}
                className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  STATUS_BUTTON_STYLES[status] || "bg-gray-600 hover:bg-gray-700 text-white"
                }`}
              >
                {updating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowRight className="w-4 h-4" />
                )}
                Move to {STATUS_LABELS[status]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Feedback Messages */}
      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-700 dark:text-green-400">
          {success}
        </div>
      )}

      {/* Add Note */}
      <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6">
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <MessageSquare className="w-4 h-4" />
          Add Note
        </h3>
        <form onSubmit={handleAddNote}>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Add a note or update..."
            rows={3}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface)] text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)] resize-none mb-2"
          />
          <button
            type="submit"
            disabled={submittingNote || !noteText.trim()}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            {submittingNote ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Adding...
              </>
            ) : (
              "Add Note"
            )}
          </button>
        </form>
      </div>

      {/* Edit Remediation Plan */}
      <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6">
        <button
          onClick={() => setShowRemediationEdit(!showRemediationEdit)}
          className="flex items-center justify-between w-full text-sm font-semibold text-white"
        >
          <span className="flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Edit Remediation Plan
          </span>
          <ChevronDown
            className={`w-4 h-4 transition-transform ${
              showRemediationEdit ? "rotate-180" : ""
            }`}
          />
        </button>

        {showRemediationEdit && (
          <form onSubmit={handleSaveRemediation} className="mt-3">
            <textarea
              value={remediationText}
              onChange={(e) => setRemediationText(e.target.value)}
              placeholder="Describe the remediation plan..."
              rows={5}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface)] text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[var(--sky-blue)] resize-none mb-2"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowRemediationEdit(false);
                  setRemediationText(remediationPlan);
                }}
                className="flex-1 px-4 py-2 text-sm font-medium text-[var(--sky-text-secondary)] hover:bg-[var(--sky-surface-overlay)] rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingRemediation}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[var(--sky-royal)] hover:bg-[var(--sky-blue)] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {savingRemediation ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Plan"
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

