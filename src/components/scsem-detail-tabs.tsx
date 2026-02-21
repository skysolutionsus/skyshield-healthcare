"use client";

import { useState, useEffect } from "react";
import { Download, ChevronDown, ChevronUp, FileSpreadsheet, Clock, Shield, Table2, ScrollText, AlertCircle } from "lucide-react";

interface SCSEMControl {
    id: string;
    testId: string;
    nistId: string | null;
    nistControlName: string | null;
    testMethod: string | null;
    sectionTitle: string | null;
    description: string | null;
    testProcedures: string | null;
    expectedResults: string | null;
    actualResults: string | null;
    status: string | null;
    findingStatement: string | null;
    notesEvidence: string | null;
    criticality: string | null;
    issueCode: string | null;
    issueCodeDescription: string | null;
    cisBenchmarkRef: string | null;
    recommendationNum: string | null;
    rationale: string | null;
    impact: string | null;
    remediationProcedure: string | null;
    remediationStatement: string | null;
    capRequestStatement: string | null;
    riskRating: string | null;
    updateHighlight: boolean;
    lastSyncedAt: string | null;
    lastSyncedVersion: string | null;
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

function formatDate(dateStr: string): string {
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    } catch {
        return dateStr;
    }
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
                    // Default to: test_cases with controls > any sheet with controls > first sheet
                    const testSheet = json.sheets.find((s: SCSEMSheet) => s.sheetType === "test_cases" && s.controls.length > 0);
                    const anyWithControls = json.sheets.find((s: SCSEMSheet) => s.controls.length > 0);
                    setActiveTab(testSheet?.id || anyWithControls?.id || json.sheets[0]?.id || "");
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
                </div>

                {/* Active Sheet Content */}
                <div className="p-4">
                    {activeSheet && activeSheet.controls.length > 0 ? (
                        <ControlsTable
                            controls={activeSheet.controls}
                            expandedControls={expandedControls}
                            onToggle={toggleControl}
                        />
                    ) : activeSheet && activeSheet.rawData && activeSheet.rawData.length > 0 ? (
                        <RawDataTable rows={activeSheet.rawData} />
                    ) : (
                        <div className="text-center py-8 text-[var(--sky-text-secondary)]">
                            <p>This sheet ({activeSheet?.sheetName || "unknown"}) has no data.</p>
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
                        <th className="py-2 px-3 text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Criticality</th>
                        <th className="py-2 px-3 text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider">Status</th>
                    </tr>
                </thead>
                <tbody>
                    {controls.map((control) => {
                        const isExpanded = expandedControls.has(control.id);
                        return (
                            <tbody key={control.id}>
                                <tr
                                    onClick={() => onToggle(control.id)}
                                    className={`border-b border-[var(--sky-border)]/50 hover:bg-[var(--sky-bg)] cursor-pointer transition-colors ${control.updateHighlight
                                        ? "border-l-2 border-l-amber-400 bg-amber-500/5"
                                        : ""
                                        }`}
                                >
                                    <td className="py-2.5 px-3 text-[var(--sky-text-secondary)]">
                                        {isExpanded
                                            ? <ChevronUp className="w-4 h-4" />
                                            : <ChevronDown className="w-4 h-4" />}
                                    </td>
                                    <td className="py-2.5 px-3 font-mono text-blue-400 text-xs">{control.testId}</td>
                                    <td className="py-2.5 px-3 font-mono text-xs text-[var(--sky-text-secondary)]">{control.nistId || "—"}</td>
                                    <td className="py-2.5 px-3 text-white text-xs max-w-[250px] truncate">{control.nistControlName || "—"}</td>
                                    <td className="py-2.5 px-3 text-xs text-[var(--sky-text-secondary)]">{control.testMethod || "—"}</td>
                                    <td className="py-2.5 px-3">
                                        <CriticalityBadge criticality={control.criticality} />
                                    </td>
                                    <td className="py-2.5 px-3">
                                        <StatusBadge status={control.status} />
                                    </td>
                                </tr>
                                {isExpanded && (
                                    <tr className="bg-[var(--sky-bg)]/50">
                                        <td colSpan={7} className="p-4">
                                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
                                                {control.sectionTitle && (
                                                    <DetailField label="Section Title" value={control.sectionTitle} />
                                                )}
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
                                                {control.findingStatement && (
                                                    <DetailField label="Finding Statement" value={control.findingStatement} />
                                                )}
                                                {control.notesEvidence && (
                                                    <DetailField label="Notes / Evidence" value={control.notesEvidence} />
                                                )}
                                                {control.issueCode && (
                                                    <DetailField label="Issue Code Mapping" value={control.issueCode} />
                                                )}
                                                {control.issueCodeDescription && (
                                                    <DetailField label="Issue Code Description" value={control.issueCodeDescription} />
                                                )}
                                                {control.cisBenchmarkRef && (
                                                    <DetailField label="CIS Benchmark Section" value={control.cisBenchmarkRef} />
                                                )}
                                                {control.recommendationNum && (
                                                    <DetailField label="Recommendation #" value={control.recommendationNum} />
                                                )}
                                                {control.rationale && (
                                                    <DetailField label="Rationale" value={control.rationale} />
                                                )}
                                                {control.impact && (
                                                    <DetailField label="Impact" value={control.impact} />
                                                )}
                                                {control.remediationProcedure && (
                                                    <DetailField label="Remediation Procedure" value={control.remediationProcedure} />
                                                )}
                                                {control.remediationStatement && (
                                                    <DetailField label="Remediation Statement" value={control.remediationStatement} />
                                                )}
                                                {control.capRequestStatement && (
                                                    <DetailField label="CAP Request Statement" value={control.capRequestStatement} />
                                                )}
                                                {control.riskRating && (
                                                    <DetailField label="Risk Rating" value={control.riskRating} />
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
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

function CriticalityBadge({ criticality }: { criticality: string | null }) {
    if (!criticality) return <span className="text-xs text-[var(--sky-text-secondary)]">—</span>;

    const colors: Record<string, string> = {
        Critical: "bg-red-500/20 text-red-400 border-red-500/30",
        Significant: "bg-orange-500/20 text-orange-400 border-orange-500/30",
        Moderate: "bg-amber-500/20 text-amber-400 border-amber-500/30",
        Limited: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
        Informational: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    };

    const colorClass = colors[criticality] || "bg-gray-500/20 text-gray-400 border-gray-500/30";

    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${colorClass}`}>
            {criticality}
        </span>
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
                                    {formatDate(entry.changeDate)}
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

/**
 * Generic raw data table renderer for any XLSX sheet
 * Renders the raw cell data exactly as it appears in the spreadsheet
 */
function RawDataTable({ rows }: { rows: any[][] }) {
    if (!rows || rows.length === 0) return null;

    // Format cell values for display
    const formatCell = (val: any): string => {
        if (val === null || val === undefined || val === '') return '';
        // Detect Excel serial dates (numbers between 30000-50000 that aren't regular numbers)
        if (typeof val === 'number' && val > 30000 && val < 60000) {
            try {
                const d = new Date((val - 25569) * 86400000);
                if (!isNaN(d.getTime())) {
                    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
                }
            } catch { }
        }
        return String(val);
    };

    // Find the max number of columns across all rows
    const maxCols = Math.max(...rows.map(r => (r as any[]).length));

    // Find header-like row: first row where multiple cells have content
    let headerIdx = -1;
    for (let i = 0; i < Math.min(3, rows.length); i++) {
        const nonEmpty = (rows[i] as any[]).filter(c => c !== '' && c !== null && c !== undefined).length;
        if (nonEmpty >= 2) {
            headerIdx = i;
            break;
        }
    }

    // Rows before the header are title/metadata rows
    const preHeaderRows = headerIdx > 0 ? rows.slice(0, headerIdx) : [];
    const headerRow = headerIdx >= 0 ? rows[headerIdx] as any[] : null;
    const dataRows = headerIdx >= 0 ? rows.slice(headerIdx + 1) : rows;

    // Filter out columns that are entirely empty in data rows
    const activeCols: number[] = [];
    for (let c = 0; c < maxCols; c++) {
        const hasData = dataRows.some(r => {
            const val = (r as any[])[c];
            return val !== '' && val !== null && val !== undefined;
        }) || (headerRow && formatCell(headerRow[c]));
        if (hasData) activeCols.push(c);
    }

    // If very few active columns or rows, show as a simple key-value layout
    if (activeCols.length <= 2 && dataRows.length <= 1) {
        return (
            <div className="space-y-2">
                {preHeaderRows.map((row, i) => {
                    const text = (row as any[]).filter(c => c !== '' && c !== null).map(c => formatCell(c)).join(' ');
                    if (!text) return null;
                    return (
                        <div key={i} className="text-sm text-white/80 font-medium">{text}</div>
                    );
                })}
                {rows.filter(r => {
                    const cells = (r as any[]).filter(c => c !== '' && c !== null);
                    return cells.length > 0;
                }).map((row, i) => {
                    const cells = (row as any[]).filter(c => c !== '' && c !== null);
                    return (
                        <div key={i} className="text-sm text-white/70">{cells.map(c => formatCell(c)).join(': ')}</div>
                    );
                })}
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {/* Pre-header title rows */}
            {preHeaderRows.map((row, i) => {
                const text = (row as any[]).filter(c => c !== '' && c !== null).map(c => formatCell(c)).join(' — ');
                if (!text) return null;
                return (
                    <div key={i} className="text-sm font-semibold text-white/80">{text}</div>
                );
            })}

            {/* Main data table */}
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    {headerRow && (
                        <thead>
                            <tr className="border-b border-[var(--sky-border)]">
                                {activeCols.map(c => (
                                    <th key={c} className="py-2 px-3 text-left text-xs font-semibold text-[var(--sky-text-secondary)] uppercase tracking-wider whitespace-nowrap">
                                        {formatCell(headerRow[c]) || ''}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                    )}
                    <tbody>
                        {dataRows.map((row, i) => {
                            const cells = row as any[];
                            // Skip completely empty rows
                            const hasContent = activeCols.some(c => cells[c] !== '' && cells[c] !== null && cells[c] !== undefined);
                            if (!hasContent) return null;
                            return (
                                <tr key={i} className="border-b border-[var(--sky-border)]/30 hover:bg-[var(--sky-bg)]">
                                    {activeCols.map(c => (
                                        <td key={c} className="py-2 px-3 text-xs text-white/80 whitespace-pre-wrap max-w-[400px]">
                                            {formatCell(cells[c])}
                                        </td>
                                    ))}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

