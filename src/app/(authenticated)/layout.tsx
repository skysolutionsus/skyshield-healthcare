import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
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

  return (
    <SessionProvider>
      <AppShell
        user={{
          name: session.user.name,
          email: session.user.email,
          role: (session.user as unknown as { role: string }).role,
        }}
      >
        {children}
      </AppShell>
    </SessionProvider>
  );
}
