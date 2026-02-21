"use client";

import { useState, useEffect } from "react";
import { Download, ChevronDown, ChevronUp, FileSpreadsheet, Clock, Shield, Table2, ScrollText, AlertCircle } from "lucide-react";

interface SCSEMControl {
    id: string;
    testId: string;
    nistId: string | null;
    nistControlName: string | null;
    testMethod: string | null;
    description: string | null;
    testProcedures: string | null;
    expectedResults: string | null;
    actualResults: string | null;
    status: string | null;
    notesEvidence: string | null;
}

interface SCSEMSheet {
    id: string;
    sheetName: string;
    sheetType: string;
    sheetIndex: number;
    rawData: any[][] | null;
    controls: SCSEMControl[];
}

interface SCSEMChangeLogEntry {
    id: string;
    version: string;
    changeDate: string;
    description: string;
    changedBy: string | null;
    source: string;
}

interface SCSEMDetailData {
    sheets: SCSEMSheet[];
    changeLogs: SCSEMChangeLogEntry[];
}

export function SCSEMDetailTabs({ templateId }: { templateId: string }) {
    const [data, setData] = useState<SCSEMDetailData | null>(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<string>("");
    const [expandedControls, setExpandedControls] = useState<Set<string>>(new Set());

    useEffect(() => {
        async function fetchDetail() {
            try {
                const res = await fetch(`/api/scsems/${templateId}`);
                if (res.ok) {
                    const json = await res.json();
                    setData({ sheets: json.sheets, changeLogs: json.changeLogs });
                    // Default to first test_cases sheet or first sheet
                    const testSheet = json.sheets.find((s: SCSEMSheet) => s.sheetType === "test_cases");
                    setActiveTab(testSheet?.id || json.sheets[0]?.id || "");
                }
            } catch (err) {
                console.error("Failed to fetch SCSEM detail:", err);
            } finally {
                setLoading(false);
            }
        }
        fetchDetail();
    }, [templateId]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12 text-[var(--sky-text-secondary)]">
                <div className="animate-spin w-5 h-5 border-2 border-current border-t-transparent rounded-full mr-3" />
                Loading SCSEM data…
            </div>
        );
    }

    if (!data || data.sheets.length === 0) {
        return (
            <div className="text-center py-12 text-[var(--sky-text-secondary)]">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                No sheet data available for this SCSEM.
            </div>
        );
    }

    const activeSheet = data.sheets.find((s) => s.id === activeTab);

    const toggleControl = (id: string) => {
        setExpandedControls((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const getSheetIcon = (type: string) => {
        switch (type) {
            case "test_cases": return <Table2 className="w-3.5 h-3.5" />;
            case "dashboard": return <FileSpreadsheet className="w-3.5 h-3.5" />;
            case "changelog": return <Clock className="w-3.5 h-3.5" />;
            case "instructions": return <ScrollText className="w-3.5 h-3.5" />;
            default: return <FileSpreadsheet className="w-3.5 h-3.5" />;
        }
    };

    const getSheetLabel = (sheet: SCSEMSheet) => {
        if (sheet.sheetType === "test_cases") {
            return `${sheet.sheetName} (${sheet.controls.length})`;
        }
        return sheet.sheetName;
    };

    return (
        <div className="space-y-4">
            {/* Export Button */}
            <div className="flex justify-end">
                <a
                    href={`/api/scsems/${templateId}/export`}
                    download
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
                >
                    <Download className="w-4 h-4" />
                    Export XLSX
                </a>
            </div>

            {/* Sheet Tabs */}
            <div className="border border-[var(--sky-border)] rounded-xl overflow-hidden bg-[var(--sky-surface)]">
                <div className="flex overflow-x-auto border-b border-[var(--sky-border)] bg-[var(--sky-bg)]">
                    {data.sheets.map((sheet) => (
                        <button
                            key={sheet.id}
                            onClick={() => setActiveTab(sheet.id)}
                            className={`flex items-center gap-1.5 px-4 py-3 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${activeTab === sheet.id
                                    ? "border-blue-500 text-blue-400 bg-[var(--sky-surface)]"
                                    : "border-transparent text-[var(--sky-text-secondary)] hover:text-white hover:border-[var(--sky-border)]"
                                }`}
                        >
                            {getSheetIcon(sheet.sheetType)}
                            {getSheetLabel(sheet)}
                        </button>
                    ))}
                    {/* Changelog tab */}
                    {data.changeLogs.length > 0 && (
                        <button
                            onClick={() => setActiveTab("changelog")}
                            className={`flex items-center gap-1.5 px-4 py-3 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${activeTab === "changelog"
                                    ? "border-blue-500 text-blue-400 bg-[var(--sky-surface)]"
                                    : "border-transparent text-[var(--sky-text-secondary)] hover:text-white hover:border-[var(--sky-border)]"
                                }`}
                        >
                            <Clock className="w-3.5 h-3.5" />
                            Change Log ({data.changeLogs.length})
                        </button>
                    )}
                </div>

                {/* Active Sheet Content */}
                <div className="p-4">
                    {activeTab === "changelog" ? (
                        <ChangeLogView entries={data.changeLogs} />
                    ) : activeSheet?.sheetType === "test_cases" ? (
                        <ControlsTable
                            controls={activeSheet.controls}
                            expandedControls={expandedControls}
                            onToggle={toggleControl}
                        />
                    ) : activeSheet?.rawData ? (
                        <RawDataView rawData={activeSheet.rawData} />
                    ) : (
                        <div className="text-center py-8 text-[var(--sky-text-secondary)]">
                            No content available for this sheet.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function ControlsTable({
    controls,
    expandedControls,
    onToggle,
}: {
    controls: SCSEMControl[];
    expandedControls: Set<string>;
    onToggle: (id: string) => void;
}) {
    if (controls.length === 0) {
        return <div className="text-sm text-[var(--sky-text-secondary)]">No controls in this sheet.</div>;
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-[var(--sky-border)] text-left">
                        <th className="py-2 px-3 text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider w-8"></th>
                        <th className="py-2 px-3 text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Test ID</th>
                        <th className="py-2 px-3 text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">NIST ID</th>
                        <th className="py-2 px-3 text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Control Name</th>
                        <th className="py-2 px-3 text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Method</th>
                        <th className="py-2 px-3 text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Status</th>
                    </tr>
                </thead>
                <tbody>
                    {controls.map((control) => {
                        const isExpanded = expandedControls.has(control.id);
                        return (
                            <>
                                <tr
                                    key={control.id}
                                    onClick={() => onToggle(control.id)}
                                    className="border-b border-[var(--sky-border)]/50 hover:bg-[var(--sky-bg)] cursor-pointer transition-colors"
                                >
                                    <td className="py-2.5 px-3 text-[var(--sky-text-secondary)]">
                                        {isExpanded
                                            ? <ChevronUp className="w-4 h-4" />
                                            : <ChevronDown className="w-4 h-4" />}
                                    </td>
                                    <td className="py-2.5 px-3 font-mono text-blue-400 text-xs">{control.testId}</td>
                                    <td className="py-2.5 px-3 font-mono text-xs text-[var(--sky-text-secondary)]">{control.nistId || "—"}</td>
                                    <td className="py-2.5 px-3 text-white text-xs max-w-[300px] truncate">{control.nistControlName || "—"}</td>
                                    <td className="py-2.5 px-3 text-xs text-[var(--sky-text-secondary)]">{control.testMethod || "—"}</td>
                                    <td className="py-2.5 px-3">
                                        <StatusBadge status={control.status} />
                                    </td>
                                </tr>
                                {isExpanded && (
                                    <tr key={`${control.id}-detail`} className="bg-[var(--sky-bg)]/50">
                                        <td colSpan={6} className="p-4">
                                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
                                                {control.description && (
                                                    <DetailField label="Description" value={control.description} />
                                                )}
                                                {control.testProcedures && (
                                                    <DetailField label="Test Procedures" value={control.testProcedures} />
                                                )}
                                                {control.expectedResults && (
                                                    <DetailField label="Expected Results" value={control.expectedResults} />
                                                )}
                                                {control.actualResults && (
                                                    <DetailField label="Actual Results" value={control.actualResults} />
                                                )}
                                                {control.notesEvidence && (
                                                    <DetailField label="Notes / Evidence" value={control.notesEvidence} />
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function DetailField({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className="font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider mb-1">{label}</div>
            <div className="text-white/80 whitespace-pre-wrap leading-relaxed">{value}</div>
        </div>
    );
}

function StatusBadge({ status }: { status: string | null }) {
    if (!status) return <span className="text-xs text-[var(--sky-text-secondary)]">—</span>;

    const colors: Record<string, string> = {
        Pass: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
        Fail: "bg-red-500/20 text-red-400 border-red-500/30",
        "N/A": "bg-gray-500/20 text-gray-400 border-gray-500/30",
        Info: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    };

    const colorClass = colors[status] || "bg-gray-500/20 text-gray-400 border-gray-500/30";

    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${colorClass}`}>
            {status}
        </span>
    );
}

function ChangeLogView({ entries }: { entries: SCSEMChangeLogEntry[] }) {
    return (
        <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-blue-400" />
                Version History
            </h3>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-[var(--sky-border)]">
                            <th className="py-2 px-3 text-left text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Version</th>
                            <th className="py-2 px-3 text-left text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Date</th>
                            <th className="py-2 px-3 text-left text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Description</th>
                            <th className="py-2 px-3 text-left text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Author</th>
                            <th className="py-2 px-3 text-left text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entries.map((entry) => (
                            <tr key={entry.id} className="border-b border-[var(--sky-border)]/50 hover:bg-[var(--sky-bg)]">
                                <td className="py-2 px-3 font-mono text-blue-400 text-xs">{entry.version}</td>
                                <td className="py-2 px-3 text-xs text-[var(--sky-text-secondary)]">
                                    {new Date(entry.changeDate).toLocaleDateString()}
                                </td>
                                <td className="py-2 px-3 text-xs text-white/80">{entry.description}</td>
                                <td className="py-2 px-3 text-xs text-[var(--sky-text-secondary)]">{entry.changedBy || "—"}</td>
                                <td className="py-2 px-3">
                                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${entry.source === "cis_sync"
                                            ? "bg-purple-500/20 text-purple-400 border-purple-500/30"
                                            : entry.source === "xlsx_import"
                                                ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                                                : "bg-gray-500/20 text-gray-400 border-gray-500/30"
                                        }`}>
                                        {entry.source === "xlsx_import" ? "XLSX" : entry.source === "cis_sync" ? "CIS Sync" : entry.source}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function RawDataView({ rawData }: { rawData: any[][] }) {
    if (!rawData || rawData.length === 0) {
        return <div className="text-sm text-[var(--sky-text-secondary)]">No data available.</div>;
    }

    return (
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
            <table className="w-full text-xs">
                <tbody>
                    {rawData.slice(0, 100).map((row, i) => (
                        <tr key={i} className="border-b border-[var(--sky-border)]/30 hover:bg-[var(--sky-bg)]">
                            {(row as any[]).slice(0, 12).map((cell, j) => (
                                <td key={j} className="py-1.5 px-2 text-white/70 max-w-[200px] truncate whitespace-nowrap">
                                    {cell !== null && cell !== undefined && cell !== "" ? String(cell) : ""}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            {rawData.length > 100 && (
                <div className="text-center py-2 text-[var(--sky-text-secondary)] text-xs">
                    Showing first 100 of {rawData.length} rows
                </div>
            )}
        </div>
    );
}
