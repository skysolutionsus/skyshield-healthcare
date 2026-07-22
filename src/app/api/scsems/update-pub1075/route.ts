import { NextResponse } from "next/server";
import { extractComplianceEvidence } from "@/lib/compliance-evidence";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";

export const runtime = "nodejs";

/**
 * Governing evidence is promoted through source control and release review.
 * A live API request must never replace the pinned Publication 1075 snapshot
 * used by in-flight or future canonical-template analyses.
 */
export async function POST() {
    const access = await requireScsemSteward();
    if (!access.ok) return access.response;

    return NextResponse.json({
        error:
            "Live Publication 1075 replacement is retired. Acquire and hash a candidate source, " +
            "review its version/content, regenerate tests, and promote it through the governed repository workflow.",
        code: "PINNED_SOURCE_PROMOTION_REQUIRED",
    }, { status: 410 });
}

export async function GET() {
    const access = await requireScsemSteward();
    if (!access.ok) return access.response;

    const evidence = extractComplianceEvidence([]);
    return NextResponse.json({
        mode: "pinned_read_only",
        version: evidence.pub1075.version,
        sourcePath: evidence.pub1075.sourcePath,
        sourceSha256: evidence.pub1075.sourceSha256,
        updatePolicy:
            "Stage, review, test, and promote Publication 1075 source changes through the governed repository workflow.",
    });
}
