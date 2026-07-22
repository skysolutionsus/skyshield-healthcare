import { NextResponse } from "next/server";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";

export const runtime = "nodejs";

/**
 * The legacy review path wrote suggestions directly into the shared template
 * database. Canonical updates now flow through the reviewer-gated updater and
 * workbook export, so this unsafe mutation surface is intentionally retired.
 */
export async function PUT() {
  const access = await requireScsemSteward();
  if (!access.ok) return access.response;

  return NextResponse.json(
    {
      error:
        "This legacy SCSEM review endpoint has been retired. Use the SCSEM Updater review and export workflow.",
    },
    { status: 410 }
  );
}
