import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { AppShell } from "@/components/app-shell";
import { SessionProvider } from "@/components/session-provider";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const scsemAccess = await requireScsemSteward();

  return (
    <SessionProvider>
      <AppShell
        user={{
          name: session.user.name,
          email: session.user.email,
          role: (session.user as unknown as { role: string }).role,
          canManageCanonicalScsems: scsemAccess.ok,
        }}
      >
        {children}
      </AppShell>
    </SessionProvider>
  );
}
