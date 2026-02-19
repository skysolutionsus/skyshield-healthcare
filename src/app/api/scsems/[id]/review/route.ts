import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id: templateId } = await params;
        const body = await request.json();
        const { reviewId, status } = body;

        if (!reviewId || !status) {
            return NextResponse.json({ error: "Missing fields" }, { status: 400 });
        }

        const review = await db.sCSEMUpdateReview.update({
            where: { id: reviewId },
            data: { status },
            include: {
                template: true,
                benchmark: true,
            }
        });

        // Also log audit
        const orgId = (session.user as unknown as { organizationId: string }).organizationId;
        await db.auditLog.create({
            data: {
                organizationId: orgId,
                userId: session.user.id,
                action: `CIS Update ${status}`,
                resourceType: "SCSEMUpdateReview",
                resourceId: review.id,
                metadata: {
                    templateName: review.template.name,
                    benchmarkVersion: review.benchmark.currentVersion,
                },
            },
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error updating SCSEM review:", error);
        return NextResponse.json(
            { error: "Failed to update SCSEM review" },
            { status: 500 }
        );
    }
}
