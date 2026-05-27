import { auth } from "@/lib/auth";
import { SCSEMUpdater } from "@/components/scsem-updater";

export default async function SCSEMUpdaterPage() {
  const session = await auth();
  if (!session?.user) return null;

  return <SCSEMUpdater />;
}
