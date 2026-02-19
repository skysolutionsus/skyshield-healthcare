"use client";

import { useState, useCallback, useMemo } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Save,
  Play,
  FileText,
  ChevronDown,
  ChevronUp,
  Search,
  Loader2,
  Filter,
} from "lucide-react";

interface ControlResult {
  id: string;
  controlId: string;
  controlName: string;
  status: string;
  notes: string;
  evidence: string;
}

interface SCSEMAssessmentWorkflowProps {
  templateId: string;
  templateName: string;
  controlCount: number;
  assessmentId: string | null;
  assessmentStatus: string;
  controlResults: ControlResult[];
  userId: string;
}

type ControlStatusType =
  | "COMPLIANT"
  | "NON_COMPLIANT"
  | "NOT_APPLICABLE"
  | "IN_PROGRESS";

const STATUS_OPTIONS: {
  value: ControlStatusType;
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}[] = [
  {
    value: "COMPLIANT",
    label: "Compliant",
    icon: <CheckCircle2 className="w-4 h-4" />,
    color: "text-green-700 dark:text-green-400",
    bgColor:
      "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 hover:bg-green-200 dark:hover:bg-green-900/50",
  },
  {
    value: "NON_COMPLIANT",
    label: "Non-Compliant",
    icon: <XCircle className="w-4 h-4" />,
    color: "text-red-700 dark:text-red-400",
    bgColor:
      "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 hover:bg-red-200 dark:hover:bg-red-900/50",
  },
  {
    value: "NOT_APPLICABLE",
    label: "N/A",
    icon: <AlertCircle className="w-4 h-4" />,
    color: "text-gray-600 dark:text-gray-400",
    bgColor:
      "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700",
  },
  {
    value: "IN_PROGRESS",
    label: "In Progress",
    icon: <Clock className="w-4 h-4" />,
    color: "text-blue-700 dark:text-blue-400",
    bgColor:
      "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 hover:bg-blue-200 dark:hover:bg-blue-900/50",
  },
];

export function SCSEMAssessmentWorkflow({
  templateId,
  templateName,
  controlCount,
  assessmentId: initialAssessmentId,
  assessmentStatus: initialStatus,
  controlResults: initialControls,
  userId,
}: SCSEMAssessmentWorkflowProps) {
  const [assessmentId, setAssessmentId] = useState<string | null>(
    initialAssessmentId
  );
  const [assessmentStatus, setAssessmentStatus] = useState(initialStatus);
  const [controls, setControls] = useState<ControlResult[]>(initialControls);
  const [expandedControl, setExpandedControl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [hasChanges, setHasChanges] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Compute compliance score
  const complianceStats = useMemo(() => {
    const compliant = controls.filter(
      (c) => c.status === "COMPLIANT"
    ).length;
    const nonCompliant = controls.filter(
      (c) => c.status === "NON_COMPLIANT"
    ).length;
    const na = controls.filter(
      (c) => c.status === "NOT_APPLICABLE"
    ).length;
    const inProgress = controls.filter(
      (c) => c.status === "IN_PROGRESS"
    ).length;
    const applicable = controls.length - na;
    const score =
      applicable > 0 ? Math.round((compliant / applicable) * 100) : 0;

    return { compliant, nonCompliant, na, inProgress, applicable, score };
  }, [controls]);

  // Filter controls
  const filteredControls = useMemo(() => {
    return controls.filter((c) => {
      const matchesSearch =
        searchQuery === "" ||
        c.controlId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.controlName.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus =
        statusFilter === "ALL" || c.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [controls, searchQuery, statusFilter]);

  // Start a new assessment
  const handleStartAssessment = useCallback(async () => {
    setStarting(true);
    try {
      const res = await fetch("/api/scsems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start assessment");
      }

      const data = await res.json();
      setAssessmentId(data.assessment.id);
      setAssessmentStatus(data.assessment.status);
      setControls(
        data.assessment.controlResults.map(
          (c: {
            id: string;
            controlId: string;
            controlName: string;
            status: string;
            notes: string | null;
            evidence: string | null;
          }) => ({
            id: c.id,
            controlId: c.controlId,
            controlName: c.controlName,
            status: c.status,
            notes: c.notes || "",
            evidence: c.evidence || "",
          })
        )
      );
    } catch (err) {
      console.error("Failed to start assessment:", err);
      setSaveMessage(
        err instanceof Error ? err.message : "Failed to start assessment"
      );
    } finally {
      setStarting(false);
    }
  }, [templateId]);

  // Update a control's status
  const handleStatusChange = useCallback(
    (controlId: string, newStatus: ControlStatusType) => {
      setControls((prev) =>
        prev.map((c) =>
          c.controlId === controlId ? { ...c, status: newStatus } : c
        )
      );
      setHasChanges(true);
    },
    []
  );

  // Update a control's notes
  const handleNotesChange = useCallback(
    (controlId: string, notes: string) => {
      setControls((prev) =>
        prev.map((c) => (c.controlId === controlId ? { ...c, notes } : c))
      );
      setHasChanges(true);
    },
    []
  );

  // Update a control's evidence
  const handleEvidenceChange = useCallback(
    (controlId: string, evidence: string) => {
      setControls((prev) =>
        prev.map((c) =>
          c.controlId === controlId ? { ...c, evidence } : c
        )
      );
      setHasChanges(true);
    },
    []
  );

  // Save all changes
  const handleSave = useCallback(async () => {
    if (!assessmentId) return;
    setSaving(true);
    setSaveMessage(null);

    try {
      const res = await fetch(`/api/scsems/${assessmentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          controlResults: controls.map((c) => ({
            id: c.id,
            controlId: c.controlId,
            controlName: c.controlName,
            status: c.status,
            notes: c.notes,
            evidence: c.evidence,
          })),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }

      const data = await res.json();
      setAssessmentStatus(data.assessment.status);
      setHasChanges(false);
      setSaveMessage("Changes saved successfully");
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (err) {
      console.error("Failed to save:", err);
      setSaveMessage(
        err instanceof Error ? err.message : "Failed to save changes"
      );
    } finally {
      setSaving(false);
    }
  }, [assessmentId, controls]);

  // No assessment started yet
  if (!assessmentId) {
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-8 text-center">
        <FileText className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
          No Assessment Started
        </h3>
        <p className="text-gray-500 dark:text-gray-400 max-w-md mx-auto mb-6">
          Start an assessment for &quot;{templateName}&quot; to evaluate your
          organization&apos;s compliance with its {controlCount} security
          controls.
        </p>
        <button
          onClick={handleStartAssessment}
          disabled={starting}
          className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
        >
          {starting ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Starting Assessment...
            </>
          ) : (
            <>
              <Play className="w-5 h-5" />
              Start Assessment
            </>
          )}
        </button>
        {saveMessage && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">
            {saveMessage}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 mb-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full sm:w-auto">
            {/* Search */}
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search controls..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Status Filter */}
            <div className="relative">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="appearance-none pl-8 pr-8 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent cursor-pointer"
              >
                <option value="ALL">All Statuses</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="COMPLIANT">Compliant</option>
                <option value="NON_COMPLIANT">Non-Compliant</option>
                <option value="NOT_APPLICABLE">N/A</option>
              </select>
              <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>
          </div>

          {/* Save Button */}
          <div className="flex items-center gap-3">
            {saveMessage && (
              <span
                className={`text-sm ${
                  saveMessage.includes("success")
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                }`}
              >
                {saveMessage}
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Save Changes
                </>
              )}
            </button>
          </div>
        </div>

        {/* Mini Stats Bar */}
        <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Score:{" "}
            <span
              className={`font-bold ${
                complianceStats.score >= 80
                  ? "text-green-600 dark:text-green-400"
                  : complianceStats.score >= 60
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-red-600 dark:text-red-400"
              }`}
            >
              {complianceStats.score}%
            </span>
          </span>
          <span className="text-xs text-green-600 dark:text-green-400">
            {complianceStats.compliant} compliant
          </span>
          <span className="text-xs text-red-600 dark:text-red-400">
            {complianceStats.nonCompliant} non-compliant
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {complianceStats.na} n/a
          </span>
          <span className="text-xs text-blue-600 dark:text-blue-400">
            {complianceStats.inProgress} in progress
          </span>
          <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
            Showing {filteredControls.length} of {controls.length}
          </span>
        </div>
      </div>

      {/* Control Results List */}
      <div className="space-y-2">
        {filteredControls.length === 0 && (
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-8 text-center">
            <Search className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No controls match your search criteria
            </p>
          </div>
        )}

        {filteredControls.map((control) => {
          const isExpanded = expandedControl === control.controlId;
          const currentStatus = STATUS_OPTIONS.find(
            (s) => s.value === control.status
          );

          return (
            <div
              key={control.controlId}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden"
            >
              {/* Control Header */}
              <div
                className="flex items-center gap-3 p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                onClick={() =>
                  setExpandedControl(isExpanded ? null : control.controlId)
                }
              >
                <div className={`shrink-0 ${currentStatus?.color || ""}`}>
                  {currentStatus?.icon || (
                    <Clock className="w-4 h-4 text-gray-400" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium text-gray-500 dark:text-gray-400">
                      {control.controlId}
                    </span>
                    <span className="text-sm text-gray-900 dark:text-white truncate">
                      {control.controlName}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-xs font-medium ${currentStatus?.color || "text-gray-500"}`}
                  >
                    {currentStatus?.label || control.status}
                  </span>
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-gray-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                  )}
                </div>
              </div>

              {/* Expanded Detail */}
              {isExpanded && (
                <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-800">
                  {/* Status Buttons */}
                  <div className="flex flex-wrap gap-2 mt-4 mb-4">
                    {STATUS_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        onClick={() =>
                          handleStatusChange(
                            control.controlId,
                            option.value
                          )
                        }
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          control.status === option.value
                            ? `${option.bgColor} ${option.color} ring-2 ring-offset-1 ring-offset-white dark:ring-offset-gray-900 ring-current`
                            : "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                        }`}
                      >
                        {option.icon}
                        {option.label}
                      </button>
                    ))}
                  </div>

                  {/* Notes */}
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Notes
                    </label>
                    <textarea
                      value={control.notes}
                      onChange={(e) =>
                        handleNotesChange(control.controlId, e.target.value)
                      }
                      placeholder="Add notes about this control..."
                      rows={2}
                      className="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                    />
                  </div>

                  {/* Evidence */}
                  <div>
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Evidence
                    </label>
                    <textarea
                      value={control.evidence}
                      onChange={(e) =>
                        handleEvidenceChange(
                          control.controlId,
                          e.target.value
                        )
                      }
                      placeholder="Document evidence of compliance or non-compliance..."
                      rows={2}
                      className="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Floating Save Bar */}
      {hasChanges && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
          <div className="bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-full shadow-lg px-6 py-3 flex items-center gap-4">
            <span className="text-sm font-medium">
              You have unsaved changes
            </span>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-full transition-colors"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Save
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
