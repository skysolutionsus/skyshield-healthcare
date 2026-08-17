"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Database,
  FilePlus2,
  Loader2,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";

interface KnowledgeDocument {
  id: string;
  title: string;
  sourceType: string;
  sourceName: string | null;
  version: string | null;
  description: string | null;
  metadata: unknown;
  status: string;
  chunkCount: number;
  importedAt: string;
  importedBy?: { name: string; email: string } | null;
  _count?: { chunks: number };
}

interface KnowledgeChunk {
  id: string;
  chunkIndex: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  heading: string | null;
  tokenCount: number;
  matchType?: string;
  documentTitle?: string;
}

interface KnowledgeStats {
  documentCount: number;
  chunkCount: number;
  embeddedChunkCount: number;
  auditCount: number;
  embeddingConfigured: boolean;
}

const SOURCE_TYPES = [
  "pub1075",
  "interim_guidance",
  "nist",
  "scsem",
  "irs_guidance",
  "internal_policy",
  "document",
];
const CHUNK_PAGE_SIZE = 10;

function metadataPreview(metadata: unknown) {
  if (!metadata) return "No metadata";
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return String(metadata);
  }
}

function metadataField(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  return String(value);
}

export function KnowledgeConsole() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<KnowledgeDocument | null>(null);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [chunkLoading, setChunkLoading] = useState(false);
  const [chunkPage, setChunkPage] = useState(1);
  const [chunkTotalPages, setChunkTotalPages] = useState(1);
  const [chunkTotalCount, setChunkTotalCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<KnowledgeChunk[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileForm, setFileForm] = useState({
    title: "",
    sourceType: "interim_guidance",
    sourceName: "",
    version: "",
    guidanceDate: "",
    effectiveDate: "",
    authority: "IRS Office of Safeguards interim guidance",
    description: "",
    metadata: "{\n  \"relationshipToPub1075\": \"supersedes_or_amends\"\n}",
  });
  const [form, setForm] = useState({
    title: "",
    sourceType: "document",
    sourceName: "",
    version: "",
    description: "",
    metadata: "{\n  \"owner\": \"IRS Office of Safeguards\"\n}",
    content: "",
  });

  const embeddedPercent = useMemo(() => {
    if (!stats?.chunkCount) return 0;
    return Math.round((stats.embeddedChunkCount / stats.chunkCount) * 100);
  }, [stats]);

  async function loadDocuments() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/knowledge", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load documents");
      setDocuments(data.documents || []);
      setStats(data.stats || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }

  async function loadDocumentDetail(document: KnowledgeDocument, page = 1) {
    setSelectedDocument(document);
    setChunks([]);
    setChunkLoading(true);
    try {
      const res = await fetch(
        `/api/admin/knowledge/${document.id}?page=${page}&pageSize=${CHUNK_PAGE_SIZE}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (res.ok) {
        setSelectedDocument(data.document);
        setChunks(data.chunks || []);
        setChunkPage(data.page || page);
        setChunkTotalPages(data.totalPages || 1);
        setChunkTotalCount(data.totalChunks || data.chunks?.length || 0);
      }
    } catch {
      // keep document selected even if chunk preview fails
    } finally {
      setChunkLoading(false);
    }
  }

  async function syncLatestPub1075() {
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/admin/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync_pub1075" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to sync Pub 1075");
      setNotice(
        `Synced official Pub 1075 from IRS.gov: ${data.chunkCount} chunks, ${data.embeddedChunkCount} embedded.`
      );
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync Pub 1075");
    } finally {
      setImporting(false);
    }
  }

  async function importBundledInterimGuidance() {
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/admin/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import_bundled_interim_guidance" }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to import bundled interim guidance");
      }
      setNotice(
        `Imported bundled interim guidance: ${data.documentCount} documents, ${data.chunkCount} chunks, ${data.embeddedChunkCount} embedded.`
      );
      await loadDocuments();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to import bundled interim guidance"
      );
    } finally {
      setImporting(false);
    }
  }

  async function uploadDocumentFile() {
    if (!selectedFile) return;

    setImporting(true);
    setError("");
    setNotice("");
    try {
      const formData = new FormData();
      formData.append("action", "import_file");
      formData.append("file", selectedFile);
      for (const [key, value] of Object.entries(fileForm)) {
        if (value.trim()) formData.append(key, value);
      }

      const res = await fetch("/api/admin/knowledge", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to upload document");

      setNotice(
        `Imported ${fileForm.sourceType.replace("_", " ")}: ${data.chunkCount} chunks, ${data.embeddedChunkCount} embedded.`
      );
      setSelectedFile(null);
      setFileForm({
        title: "",
        sourceType: "interim_guidance",
        sourceName: "",
        version: "",
        guidanceDate: "",
        effectiveDate: "",
        authority: "IRS Office of Safeguards interim guidance",
        description: "",
        metadata: "{\n  \"relationshipToPub1075\": \"supersedes_or_amends\"\n}",
      });
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload document");
    } finally {
      setImporting(false);
    }
  }

  async function importTextDocument() {
    setImporting(true);
    setError("");
    try {
      const res = await fetch("/api/admin/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import_text", ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to import document");
      setForm((current) => ({ ...current, title: "", sourceName: "", version: "", description: "", content: "" }));
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import document");
    } finally {
      setImporting(false);
    }
  }

  async function deleteDocument(document: KnowledgeDocument) {
    if (!confirm(`Delete "${document.title}" and all of its chunks?`)) return;
    try {
      const res = await fetch(`/api/admin/knowledge/${document.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete document");
      if (selectedDocument?.id === document.id) {
        setSelectedDocument(null);
        setChunks([]);
        setChunkPage(1);
        setChunkTotalPages(1);
        setChunkTotalCount(0);
      }
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete document");
    }
  }

  async function runSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/knowledge/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      setSearchResults(data.results || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    loadDocuments();
  }, []);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {notice}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard icon={BookOpen} label="Documents" value={stats?.documentCount ?? 0} />
        <StatCard icon={Database} label="Chunks" value={stats?.chunkCount ?? 0} />
        <StatCard icon={ShieldCheck} label="Embedded" value={`${embeddedPercent}%`} />
        <StatCard icon={FilePlus2} label="Audits" value={stats?.auditCount ?? 0} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-2xl border border-[var(--sky-border)] bg-[var(--sky-surface)] overflow-hidden">
          <div className="flex flex-col items-start gap-3 border-b border-[var(--sky-border)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div>
              <h2 className="font-semibold text-white">Knowledge Documents</h2>
              <p className="text-sm text-[var(--sky-text-muted)]">
                Admin-only database view for source documents, chunks, metadata, and status.
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
              <button
                onClick={importBundledInterimGuidance}
                disabled={importing}
                className="min-h-11 w-full rounded-lg bg-[var(--sky-surface-overlay)] px-3 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50 sm:w-auto"
              >
                {importing ? "Importing..." : "Import Interim Guidance"}
              </button>
              <button
                onClick={syncLatestPub1075}
                disabled={importing}
                className="min-h-11 w-full rounded-lg bg-[var(--sky-royal)] px-3 py-2 text-sm font-medium text-white transition hover:bg-[var(--sky-blue)] disabled:opacity-50 sm:w-auto"
              >
                {importing ? "Syncing..." : "Sync Latest Pub 1075"}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto overscroll-x-contain">
            <table className="w-full min-w-[44rem]">
              <thead>
                <tr className="border-b border-[var(--sky-border)] text-left text-xs uppercase tracking-wider text-[var(--sky-text-muted)]">
                  <th className="px-4 py-3 font-medium">Document</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Chunks</th>
                  <th className="px-4 py-3 font-medium">Imported</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--sky-border)]">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-sm text-[var(--sky-text-muted)]">
                      <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                      Loading knowledge database...
                    </td>
                  </tr>
                ) : documents.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-sm text-[var(--sky-text-muted)]">
                      No documents imported yet.
                    </td>
                  </tr>
                ) : (
                  documents.map((document) => (
                    <tr key={document.id} className="align-top hover:bg-white/[0.03]">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => loadDocumentDetail(document)}
                          className="text-left"
                        >
                          <p className="font-medium text-white">{document.title}</p>
                          <p className="mt-1 max-w-xl truncate text-xs text-[var(--sky-text-muted)]">
                            {document.description || document.sourceName || "No description"}
                          </p>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-200">
                          {document.sourceType}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--sky-text-secondary)]">
                        {document._count?.chunks ?? document.chunkCount}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--sky-text-secondary)]">
                        {formatDateTime(new Date(document.importedAt))}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => deleteDocument(document)}
                          className="rounded-lg p-2 text-[var(--sky-text-muted)] transition hover:bg-red-500/10 hover:text-red-300"
                          title="Delete document"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
          <h2 className="font-semibold text-white">Upload Interim Guidance</h2>
          <p className="mt-1 text-sm text-[var(--sky-text-muted)]">
            Upload PDF, TXT, MD, Markdown, or CSV guidance that supersedes or amends Pub 1075.
          </p>

          <div className="mt-4 space-y-3">
            <input
              type="file"
              accept=".pdf,.txt,.md,.markdown,.csv,text/*,application/pdf"
              onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
              className="w-full rounded-lg border border-dashed border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-3 text-sm text-[var(--sky-text-secondary)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--sky-royal)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
            />
            <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-100">
              SkyShield will infer the title, guidance date, effective date, Pub 1075 sections,
              impacted controls, resources, and contact details from the file.
            </div>
            <button
              onClick={uploadDocumentFile}
              disabled={importing || !selectedFile}
              className="w-full rounded-lg bg-[var(--sky-royal)] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[var(--sky-blue)] disabled:opacity-50"
            >
              {importing ? "Uploading..." : "Upload & Embed Guidance"}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
          <h2 className="font-semibold text-white">Add Document</h2>
          <p className="mt-1 text-sm text-[var(--sky-text-muted)]">
            Paste NIST, IRS guidance, policy text, or SCSEM reference material with searchable metadata.
          </p>

          <div className="mt-4 space-y-3">
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Title"
              className="w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-sm text-white outline-none focus:border-[var(--sky-blue)]"
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <select
                value={form.sourceType}
                onChange={(e) => setForm({ ...form, sourceType: e.target.value })}
                className="min-w-0 w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-base text-white outline-none sm:text-sm"
              >
                {SOURCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <input
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                placeholder="Version"
                className="min-w-0 w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-base text-white outline-none sm:text-sm"
              />
            </div>
            <input
              value={form.sourceName}
              onChange={(e) => setForm({ ...form, sourceName: e.target.value })}
              placeholder="Source name or URL"
              className="w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-sm text-white outline-none"
            />
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Description"
              rows={2}
              className="w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-sm text-white outline-none"
            />
            <textarea
              value={form.metadata}
              onChange={(e) => setForm({ ...form, metadata: e.target.value })}
              placeholder='{"framework":"NIST SP 800-53"}'
              rows={4}
              className="w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 font-mono text-xs text-white outline-none"
            />
            <textarea
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              placeholder="Paste document text here..."
              rows={8}
              className="w-full rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-sm text-white outline-none"
            />
            <button
              onClick={importTextDocument}
              disabled={importing || !form.title.trim() || !form.content.trim()}
              className="w-full rounded-lg bg-[var(--sky-royal)] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[var(--sky-blue)] disabled:opacity-50"
            >
              {importing ? "Importing..." : "Import Document"}
            </button>
          </div>
        </section>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-2xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
          <div className="flex items-center gap-2">
            <Search className="h-5 w-5 text-sky-300" />
            <h2 className="font-semibold text-white">Hybrid Search Preview</h2>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch();
              }}
              placeholder="Try: encryption requirements for FTI at rest"
              className="min-w-0 flex-1 rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-sm text-white outline-none focus:border-[var(--sky-blue)]"
            />
            <button
              onClick={runSearch}
              disabled={searching}
              className="min-h-11 w-full rounded-lg bg-[var(--sky-surface-overlay)] px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50 sm:w-auto"
            >
              {searching ? "Searching..." : "Search"}
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {searchResults.map((result) => (
              <ChunkPreview key={result.id} chunk={result} />
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
          <h2 className="font-semibold text-white">Document Detail</h2>
          {!selectedDocument ? (
            <p className="mt-4 text-sm text-[var(--sky-text-muted)]">
              Select a document to inspect metadata and chunk previews.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              <div>
                <p className="text-lg font-semibold text-white">{selectedDocument.title}</p>
                <p className="text-sm text-[var(--sky-text-muted)]">
                  {selectedDocument.sourceType} {selectedDocument.version ? `| ${selectedDocument.version}` : ""}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <MiniStat label="Chunks" value={chunkTotalCount || selectedDocument.chunkCount} />
                <MiniStat
                  label="Pages"
                  value={metadataField(selectedDocument.metadata, "pageCount") || "Unknown"}
                />
                <MiniStat
                  label="PDF KB"
                  value={metadataField(selectedDocument.metadata, "pdfSizeKB") || "Unknown"}
                />
              </div>
              <pre className="max-h-48 overflow-auto rounded-xl border border-[var(--sky-border)] bg-black/20 p-3 text-xs text-slate-300">
                {metadataPreview(selectedDocument.metadata)}
              </pre>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-[var(--sky-text-muted)]">
                    Showing chunks {chunks.length > 0 ? (chunkPage - 1) * CHUNK_PAGE_SIZE + 1 : 0}
                    {"-"}
                    {Math.min(chunkPage * CHUNK_PAGE_SIZE, chunkTotalCount)} of {chunkTotalCount}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => selectedDocument && loadDocumentDetail(selectedDocument, chunkPage - 1)}
                      disabled={chunkLoading || chunkPage <= 1}
                      className="rounded-lg border border-[var(--sky-border)] p-2 text-[var(--sky-text-secondary)] transition hover:bg-white/10 disabled:opacity-40"
                      title="Previous chunks"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="text-xs text-[var(--sky-text-muted)]">
                      Page {chunkPage} of {chunkTotalPages}
                    </span>
                    <button
                      onClick={() => selectedDocument && loadDocumentDetail(selectedDocument, chunkPage + 1)}
                      disabled={chunkLoading || chunkPage >= chunkTotalPages}
                      className="rounded-lg border border-[var(--sky-border)] p-2 text-[var(--sky-text-secondary)] transition hover:bg-white/10 disabled:opacity-40"
                      title="Next chunks"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {chunkLoading ? (
                  <div className="rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-6 text-center text-sm text-[var(--sky-text-muted)]">
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                    Loading chunks...
                  </div>
                ) : (
                  chunks.map((chunk) => <ChunkPreview key={chunk.id} chunk={chunk} />)
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-3">
      <p className="text-xs uppercase tracking-wide text-[var(--sky-text-muted)]">{label}</p>
      <p className="mt-1 font-semibold text-white">{value}</p>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-2xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
      <Icon className="h-5 w-5 text-sky-300" />
      <p className="mt-4 text-2xl font-semibold text-white">{value}</p>
      <p className="text-sm text-[var(--sky-text-muted)]">{label}</p>
    </div>
  );
}

function ChunkPreview({ chunk }: { chunk: KnowledgeChunk }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = chunk.content.length > 700;

  return (
    <article className="rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {chunk.documentTitle && (
          <span className="font-medium text-sky-200">{chunk.documentTitle}</span>
        )}
        {chunk.section && (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-200">
            {chunk.section}
          </span>
        )}
        {chunk.pageStart && (
          <span className="text-[var(--sky-text-muted)]">
            page {chunk.pageStart}
            {chunk.pageEnd && chunk.pageEnd !== chunk.pageStart ? `-${chunk.pageEnd}` : ""}
          </span>
        )}
        {chunk.matchType && (
          <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-sky-200">
            {chunk.matchType}
          </span>
        )}
      </div>
      {chunk.heading && <p className="mb-2 text-sm font-medium text-white">{chunk.heading}</p>}
      <p
        className={`break-words [overflow-wrap:anywhere] whitespace-pre-wrap text-sm leading-6 text-[var(--sky-text-secondary)] ${
          expanded ? "" : "line-clamp-6"
        }`}
      >
        {chunk.content}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded((current) => !current)}
          className="mt-3 text-xs font-medium text-sky-200 transition hover:text-white"
        >
          {expanded ? "Collapse chunk" : "Show full chunk"}
        </button>
      )}
    </article>
  );
}
