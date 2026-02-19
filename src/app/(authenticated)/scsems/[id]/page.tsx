import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  FileSpreadsheet,
  Shield,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { SCSEMUpdateReview } from "@/components/scsem-update-review";

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
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      <Link
        href="/scsems"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--sky-text-secondary)] hover:text-white transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to SCSEM Library
      </Link>

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
              <div className="flex flex-wrap items-center gap-3 mt-2">
                <span className="inline-flex items-center gap-1 text-sm text-[var(--sky-text-secondary)]">
                  <Shield className="w-4 h-4" />
                  {template.category}
                </span>
                {template.cisTechnology ? (
                  <span className="text-sm text-[var(--sky-text-secondary)]">
                    CIS Technology: {template.cisTechnology}
                  </span>
                ) : template.version && (
                  <span className="text-sm text-[var(--sky-text-secondary)]">
                    Version {template.version}
                  </span>
                )}
                <span className="text-sm text-[var(--sky-text-secondary)]">
                  {template.controlCount} controls
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <SCSEMUpdateReview
        templateId={template.id}
        templateName={template.name}
        review={reviewRecord ? {
          id: reviewRecord.id,
          status: reviewRecord.status,
          suggestedChanges: reviewRecord.suggestedChanges as any,
          benchmark: {
            currentVersion: reviewRecord.benchmark.currentVersion,
            changesSummary: reviewRecord.benchmark.changesSummary,
          }
        } : null}
      />
    </div>
  );
}
