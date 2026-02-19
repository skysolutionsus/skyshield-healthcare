import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  FileSpreadsheet,
  CheckCircle2,
  Clock,
  AlertCircle,
  XCircle,
  Shield,
  User,
  Calendar,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { SCSEMAssessmentWorkflow } from "@/components/scsem-assessment";

interface ControlResultData {
  id: string;
  controlId: string;
  controlName: string;
  status: string;
  notes: string | null;
  evidence: string | null;
  assignedToId: string | null;
}

interface AssessmentData {
  id: string;
  status: string;
  complianceScore: number | null;
  notes: string | null;
  assessedBy: { id: string; name: string };
  createdAt: Date;
  updatedAt: Date;
  controlResults: ControlResultData[];
}

interface TemplateData {
  id: string;
  name: string;
  category: string;
  version: string | null;
  effectiveDate: string | null;
  cisVersion: string | null;
  filePath: string;
  controlCount: number;
  assessments: AssessmentData[];
}

function getStatusIcon(status: string) {
  switch (status) {
    case "COMPLIANT":
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "NON_COMPLIANT":
      return <XCircle className="w-4 h-4 text-red-500" />;
    case "NOT_APPLICABLE":
      return <AlertCircle className="w-4 h-4 text-gray-400" />;
    case "IN_PROGRESS":
      return <Clock className="w-4 h-4 text-blue-500" />;
    default:
      return <Clock className="w-4 h-4 text-gray-400" />;
  }
}

function getStatusLabel(status: string) {
  switch (status) {
    case "COMPLIANT":
      return "Compliant";
    case "NON_COMPLIANT":
      return "Non-Compliant";
    case "NOT_APPLICABLE":
      return "N/A";
    case "IN_PROGRESS":
      return "In Progress";
    default:
      return status;
  }
}

function getAssessmentStatusBadge(status: string) {
  switch (status) {
    case "COMPLETED":
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
          <CheckCircle2 className="w-4 h-4" />
          Completed
        </span>
      );
    case "IN_PROGRESS":
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
          <Clock className="w-4 h-4" />
          In Progress
        </span>
      );
    case "REVIEW_NEEDED":
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
          <AlertCircle className="w-4 h-4" />
          Review Needed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
          Not Started
        </span>
      );
  }
}

export default async function SCSEMDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user) return null;

  const orgId = (session.user as unknown as { organizationId: string })
    .organizationId;
  const userId = session.user.id;

  let template: TemplateData | null = null;

  try {
    template = await db.sCSEMTemplate.findUnique({
      where: { id },
      include: {
        assessments: {
          where: { organizationId: orgId },
          orderBy: { updatedAt: "desc" },
          take: 1,
          include: {
            assessedBy: {
              select: { id: true, name: true },
            },
            controlResults: {
              orderBy: { controlId: "asc" },
            },
          },
        },
      },
    });
  } catch {
    // DB not available
  }

  if (!template) {
    notFound();
  }

  const assessment = template.assessments[0] || null;

  // Compute control stats
  const controls = assessment?.controlResults || [];
  const compliantCount = controls.filter(
    (c) => c.status === "COMPLIANT"
  ).length;
  const nonCompliantCount = controls.filter(
    (c) => c.status === "NON_COMPLIANT"
  ).length;
  const naCount = controls.filter(
    (c) => c.status === "NOT_APPLICABLE"
  ).length;
  const inProgressCount = controls.filter(
    (c) => c.status === "IN_PROGRESS"
  ).length;

  const applicableCount = controls.length - naCount;
  const complianceScore =
    applicableCount > 0
      ? Math.round((compliantCount / applicableCount) * 100)
      : 0;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Back Link */}
      <Link
        href="/scsems"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to SCSEM Library
      </Link>

      {/* Template Header */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6 mb-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
              <FileSpreadsheet className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                {template.name}
              </h1>
              <div className="flex flex-wrap items-center gap-3 mt-2">
                <span className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
                  <Shield className="w-4 h-4" />
                  {template.category}
                </span>
                {template.version && (
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    Version {template.version}
                  </span>
                )}
                {template.effectiveDate && (
                  <span className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
                    <Calendar className="w-4 h-4" />
                    {template.effectiveDate}
                  </span>
                )}
                {template.cisVersion && (
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    CIS {template.cisVersion}
                  </span>
                )}
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {template.controlCount} controls
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {assessment
              ? getAssessmentStatusBadge(assessment.status)
              : getAssessmentStatusBadge("NOT_STARTED")}
          </div>
        </div>
      </div>

      {/* Assessment Stats (if assessment exists) */}
      {assessment && controls.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-gray-900 dark:text-white">
              {complianceScore}%
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Compliance
            </p>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-green-600 dark:text-green-400">
              {compliantCount}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Compliant
            </p>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-red-600 dark:text-red-400">
              {nonCompliantCount}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Non-Compliant
            </p>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-gray-500 dark:text-gray-400">
              {naCount}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              N/A
            </p>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
              {inProgressCount}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              In Progress
            </p>
          </div>
        </div>
      )}

      {/* Assessment Info */}
      {assessment && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 mb-6">
          <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span className="inline-flex items-center gap-1.5">
              <User className="w-4 h-4" />
              Assessed by {assessment.assessedBy.name}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="w-4 h-4" />
              Started{" "}
              {new Date(assessment.createdAt).toLocaleDateString()}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              Last updated{" "}
              {new Date(assessment.updatedAt).toLocaleDateString()}
            </span>
            {assessment.notes && (
              <p className="w-full text-sm text-gray-600 dark:text-gray-300 mt-2">
                {assessment.notes}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Assessment Workflow Component (Client) */}
      <SCSEMAssessmentWorkflow
        templateId={template.id}
        templateName={template.name}
        controlCount={template.controlCount}
        assessmentId={assessment?.id || null}
        assessmentStatus={assessment?.status || "NOT_STARTED"}
        controlResults={controls.map((c) => ({
          id: c.id,
          controlId: c.controlId,
          controlName: c.controlName,
          status: c.status,
          notes: c.notes || "",
          evidence: c.evidence || "",
        }))}
        userId={userId}
      />
    </div>
  );
}
