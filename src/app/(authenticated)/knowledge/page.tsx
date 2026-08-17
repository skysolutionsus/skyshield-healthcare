import { redirect } from "next/navigation";
import { Database } from "lucide-react";
import { auth } from "@/lib/auth";
import { KnowledgeConsole } from "@/components/knowledge/knowledge-console";

export default async function KnowledgePage() {
  const session = await auth();
  const user = session?.user as { role: string } | undefined;

  if (!session?.user) {
    redirect("/login");
  }

  if (user?.role !== "ADMIN") {
    return (
      <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6">
          <h1 className="text-xl font-semibold text-amber-100">Admin Access Required</h1>
          <p className="mt-2 text-sm text-amber-200/80">
            Knowledge database management is restricted to Admin users.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      <div className="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-xs font-medium text-sky-200">
            <Database className="h-3.5 w-3.5" />
            Admin Knowledge Database
          </div>
          <h1 className="text-3xl font-bold text-white">Knowledge Base</h1>
          <p className="mt-2 max-w-3xl text-[var(--sky-text-secondary)]">
            Import Pub 1075, NIST standards, SCSEMs, IRS guidance, and internal policies with metadata,
            searchable chunks, embeddings, and audit trails.
          </p>
        </div>
      </div>

      <KnowledgeConsole />
    </div>
  );
}
