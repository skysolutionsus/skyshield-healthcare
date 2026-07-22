import { notFound } from "next/navigation";
import { SCSEMUpdater } from "@/components/scsem-updater";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";

export default async function SCSEMUpdaterPage() {
  const access = await requireScsemSteward();
  if (!access.ok) notFound();

  return <SCSEMUpdater />;
}
