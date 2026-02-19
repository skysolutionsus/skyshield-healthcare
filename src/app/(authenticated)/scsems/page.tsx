import Link from "next/link";
import {
  FileSpreadsheet,
  Search,
  CheckCircle2,
  Clock,
  AlertCircle,
  ChevronRight,
  Shield,
  Server,
  Database,
  Globe,
  Monitor,
  Cpu,
  Container,
  Layers,
  HardDrive,
  Laptop,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const categoryIcons: Record<string, React.ReactNode> = {
  Database: <Database className="w-5 h-5" />,
  Web: <Globe className="w-5 h-5" />,
  Network: <Server className="w-5 h-5" />,
  "UNIX-Linux": <Cpu className="w-5 h-5" />,
  Windows: <Monitor className="w-5 h-5" />,
  MacOS: <Laptop className="w-5 h-5" />,
  Mainframe: <HardDrive className="w-5 h-5" />,
  Application: <Layers className="w-5 h-5" />,
  Containers: <Container className="w-5 h-5" />,
  Virtulization: <Server className="w-5 h-5" />,
  MOT: <Shield className="w-5 h-5" />,
  Others: <FileSpreadsheet className="w-5 h-5" />,
};

const categoryColors: Record<string, string> = {
  Database: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  Web: "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800",
  Network: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800",
  "UNIX-Linux": "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800",
  Windows: "bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800",
  MacOS: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700",
  Mainframe: "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800",
  Application: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800",
  Containers: "bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400 border-teal-200 dark:border-teal-800",
  Virtulization: "bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-400 border-pink-200 dark:border-pink-800",
  MOT: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800",
  Others: "bg-slate-100 dark:bg-slate-900/30 text-slate-700 dark:text-slate-400 border-slate-200 dark:border-slate-800",
};

function getStatusBadge(status: string) {
  switch (status) {
    case "COMPLETED":
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
          <CheckCircle2 className="w-3 h-3" />
          Completed
        </span>
      );
    case "IN_PROGRESS":
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
          <Clock className="w-3 h-3" />
          In Progress
        </span>
      );
    case "REVIEW_NEEDED":
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
          <AlertCircle className="w-3 h-3" />
          Review Needed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
          Not Started
        </span>
      );
  }
}

function ComplianceScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80
      ? "text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30"
      : score >= 60
        ? "text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30"
        : "text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-900/30";

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${color}`}
    >
      {Math.round(score)}%
    </span>
  );
}

interface TemplateWithAssessment {
  id: string;
  name: string;
  category: string;
  version: string | null;
  controlCount: number;
  filePath: string;
  assessments: {
    id: string;
    status: string;
    complianceScore: number | null;
  }[];
}

export default async function SCSEMLibraryPage() {
  const session = await auth();
  if (!session?.user) return null;

  const orgId = (session.user as unknown as { organizationId: string })
    .organizationId;

  let templates: TemplateWithAssessment[] = [];

  try {
    templates = await db.sCSEMTemplate.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: {
        assessments: {
          where: { organizationId: orgId },
          select: {
            id: true,
            status: true,
            complianceScore: true,
          },
          take: 1,
          orderBy: { updatedAt: "desc" },
        },
      },
    });
  } catch {
    // DB not available — templates stays empty
  }

  // Group templates by category
  const grouped: Record<string, TemplateWithAssessment[]> = {};
  for (const tpl of templates) {
    if (!grouped[tpl.category]) {
      grouped[tpl.category] = [];
    }
    grouped[tpl.category].push(tpl);
  }

  const categories = Object.keys(grouped).sort();

  // Compute summary stats
  const totalTemplates = templates.length;
  const assessed = templates.filter(
    (t) => t.assessments.length > 0 && t.assessments[0].status === "COMPLETED"
  ).length;
  const inProgress = templates.filter(
    (t) => t.assessments.length > 0 && t.assessments[0].status === "IN_PROGRESS"
  ).length;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          SCSEM Library
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">
          Supplemental Computer Security Evaluation Matrices for IRS Publication
          1075 compliance
        </p>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <FileSpreadsheet className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {totalTemplates}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Total Templates
              </p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {assessed}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Completed
              </p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
              <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {inProgress}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                In Progress
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Empty State */}
      {templates.length === 0 && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-12 text-center">
          <FileSpreadsheet className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
            No SCSEM Templates Loaded
          </h3>
          <p className="text-gray-500 dark:text-gray-400 max-w-md mx-auto">
            SCSEM templates have not been imported yet. Run the seed script to
            load the 58 IRS SCSEM templates into the database.
          </p>
        </div>
      )}

      {/* Category Groups */}
      {categories.map((category) => (
        <div key={category} className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div
              className={`w-8 h-8 rounded-lg border flex items-center justify-center ${
                categoryColors[category] || categoryColors["Others"]
              }`}
            >
              {categoryIcons[category] || categoryIcons["Others"]}
            </div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              {category}
            </h2>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              ({grouped[category].length})
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {grouped[category].map((template) => {
              const assessment = template.assessments[0] || null;
              return (
                <Link
                  key={template.id}
                  href={`/scsems/${template.id}`}
                  className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md transition-all"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                        {template.name}
                      </h3>
                      {template.version && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          Version {template.version}
                        </p>
                      )}
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-400 dark:text-gray-600 group-hover:text-blue-500 group-hover:translate-x-0.5 transition-all shrink-0 mt-0.5" />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
                          categoryColors[template.category] ||
                          categoryColors["Others"]
                        }`}
                      >
                        {template.category}
                      </span>
                      {template.controlCount > 0 && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {template.controlCount} controls
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {assessment?.complianceScore != null && (
                        <ComplianceScoreBadge
                          score={assessment.complianceScore}
                        />
                      )}
                      {assessment
                        ? getStatusBadge(assessment.status)
                        : getStatusBadge("NOT_STARTED")}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
