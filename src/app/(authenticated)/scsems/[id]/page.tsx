import { permanentRedirect } from "next/navigation";

/** Legacy database-backed detail pages are superseded by the source-pinned updater. */
export default function SCSEMDetailPage() {
  permanentRedirect("/scsems");
}
