import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  FileSpreadsheet,
  Shield,
  Calendar,
  Hash,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { SCSEMUpdateReview } from "@/components/scsem-update-review";
import { SCSEMDetailTabs } from "@/components/scsem-detail-tabs";

export default async function SCSEMDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user) return null;

  let template = null;
  try {
    template = await db.sCSEMTemplate.findUnique({
      where: { id },
      include: {
        updateReviews: {
          where: { status: "PENDING" },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            benchmark: true,
          },
        },
      },
    });
  } catch { }

  if (!template) {
    notFound();
  }

  const reviewRecord = template.updateReviews[0] || null;

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto">
      <Link
        href="/scsems"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--sky-text-secondary)] hover:text-white transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to SCSEM Library (WIP)
      </Link>

      {/* Header Card */}
      <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-6 mb-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
              <FileSpreadsheet className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">
                {template.name}
              </h1>
              <div className="flex flex-wrap items-center gap-4 mt-2">
                <span className="inline-flex items-center gap-1.5 text-sm text-[var(--sky-text-secondary)]">
                  <Shield className="w-4 h-4" />
                  {template.category}
                </span>
                {template.version && (
                  <span className="inline-flex items-center gap-1.5 text-sm text-[var(--sky-text-secondary)]">
                    <Hash className="w-4 h-4" />
                    v{template.version}
                  </span>
                )}
                {template.effectiveDate && (
                  <span className="inline-flex items-center gap-1.5 text-sm text-[var(--sky-text-secondary)]">
                    <Calendar className="w-4 h-4" />
                    {template.effectiveDate}
                  </span>
                )}
                {template.controlCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30">
                    {template.controlCount} controls
                  </span>
                )}
                {template.cisTechnology && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30">
                    CIS: {template.cisTechnology}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Update Review Section */}
      {reviewRecord && (
        <div className="mb-6">
          <SCSEMUpdateReview
            templateId={template.id}
            templateName={template.name}
            review={{
              id: reviewRecord.id,
              status: reviewRecord.status,
              source: (reviewRecord as any).source,
              suggestedChanges: reviewRecord.suggestedChanges as any,
              benchmark: reviewRecord.benchmark ? {
                currentVersion: reviewRecord.benchmark.currentVersion,
                changesSummary: reviewRecord.benchmark.changesSummary,
              } : null
            }}
          />
        </div>
      )}

      {/* Full SCSEM Data Tabs */}
      <SCSEMDetailTabs templateId={template.id} />
    </div>
  );
}
