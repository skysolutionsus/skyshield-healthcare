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
import { SyncButton } from "@/components/sync-button";

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
  MacOS: "bg-[var(--sky-surface-overlay)] bg-[var(--sky-surface-overlay)] text-[var(--sky-text-secondary)] border-[var(--sky-border)]",
  Mainframe: "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800",
  Application: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800",
  Containers: "bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400 border-teal-200 dark:border-teal-800",
  Virtulization: "bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-400 border-pink-200 dark:border-pink-800",
  MOT: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800",
  Others: "bg-slate-100 dark:bg-slate-900/30 text-slate-700 dark:text-slate-400 border-slate-200 dark:border-slate-800",
};

function getStatusBadge(isOutdated: boolean, version: string | undefined) {
  if (isOutdated) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/50">
        <AlertCircle className="w-3 h-3" />
        CIS {version} Available
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/50">
      <CheckCircle2 className="w-3 h-3" />
      Up to Date
    </span>
  );
}

interface TemplateWithUpdates {
  id: string;
  name: string;
  category: string;
  version: string | null;
  cisTechnology: string | null;
  controlCount: number;
  filePath: string;
  updateReviews: {
    id: string;
    status: string;
    benchmark: {
      currentVersion: string;
    } | null;
  }[];
}

export default async function SCSEMLibraryPage() {
  const session = await auth();
  if (!session?.user) return null;

  const orgId = (session.user as unknown as { organizationId: string })
    .organizationId;

  let templates: TemplateWithUpdates[] = [];

  try {
    templates = await db.sCSEMTemplate.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: {
        updateReviews: {
          where: { status: "PENDING" },
          include: {
            benchmark: {
              select: { currentVersion: true }
            }
          }
        },
      },
    });
  } catch {
    // DB not available â€” templates stays empty
  }

  // Group templates by category
  const grouped: Record<string, TemplateWithUpdates[]> = {};
  for (const tpl of templates) {
    if (!grouped[tpl.category]) {
      grouped[tpl.category] = [];
    }
    grouped[tpl.category].push(tpl);
  }

  const categories = Object.keys(grouped).sort();

  // Compute summary stats
  const totalTemplates = templates.length;
  const outdated = templates.filter((t) => t.updateReviews.length > 0).length;
  const upToDate = totalTemplates - outdated;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">
            SCSEM Library
          </h1>
          <p className="text-[var(--sky-text-secondary)] mt-1">
            Supplemental Computer Security Evaluation Matrices for IRS Publication
            1075 compliance
          </p>
        </div>
        <SyncButton />
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <FileSpreadsheet className="w-5 h-5 text-[var(--sky-light)]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">
                {totalTemplates}
              </p>
              <p className="text-xs text-[var(--sky-text-secondary)]">
                Total Templates
              </p>
            </div>
          </div>
        </div>
        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">
                {upToDate}
              </p>
              <p className="text-xs text-[var(--sky-text-secondary)]">
                Up to Date
              </p>
            </div>
          </div>
        </div>
        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
              <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">
                {outdated}
              </p>
              <p className="text-xs text-[var(--sky-text-secondary)]">
                Updates Available
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Empty State */}
      {templates.length === 0 && (
        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-12 text-center">
          <FileSpreadsheet className="w-12 h-12 text-gray-300 text-[var(--sky-text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">
            No SCSEM Templates Loaded
          </h3>
          <p className="text-[var(--sky-text-secondary)] max-w-md mx-auto">
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
              className={`w-8 h-8 rounded-lg border flex items-center justify-center ${categoryColors[category] || categoryColors["Others"]
                }`}
            >
              {categoryIcons[category] || categoryIcons["Others"]}
            </div>
            <h2 className="text-lg font-semibold text-white">
              {category}
            </h2>
            <span className="text-sm text-[var(--sky-text-secondary)]">
              ({grouped[category].length})
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {grouped[category].map((template) => {
              const pendingReview = template.updateReviews[0] || null;
              const isOutdated = !!pendingReview;
              return (
                <Link
                  key={template.id}
                  href={`/scsems/${template.id}`}
                  className="group bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-5 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md transition-all relative overflow-hidden"
                >
                  {isOutdated && (
                    <div className="absolute top-0 right-0 w-16 h-16 pointer-events-none before:absolute before:content-[''] before:w-1.5 before:h-1.5 before:bg-amber-500 before:rounded-full before:top-4 before:right-4 before:animate-pulse"></div>
                  )}
                  <div className="flex items-start justify-between mb-3 pr-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors" title={template.name}>
                        {template.name}
                      </h3>
                      {template.cisTechnology ? (
                        <p className="text-xs text-[var(--sky-text-secondary)] mt-1 truncate">
                          CIS Technology: {template.cisTechnology}
                        </p>
                      ) : template.version ? (
                        <p className="text-xs text-[var(--sky-text-secondary)] mt-1 truncate">
                          Version {template.version}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-4">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border uppercase tracking-wide ${categoryColors[template.category] ||
                          categoryColors["Others"]
                          }`}
                      >
                        {template.category}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {getStatusBadge(isOutdated, pendingReview?.benchmark?.currentVersion)}
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

