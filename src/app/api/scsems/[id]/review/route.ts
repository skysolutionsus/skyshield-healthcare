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
            },
        });

        const orgId = (session.user as unknown as { organizationId: string }).organizationId;

        if (status === "ACCEPTED") {
            // Apply each suggested change to the actual SCSEMControl records
            const changes = review.suggestedChanges as any[];
            let appliedCount = 0;

            for (const change of changes) {
                if (!change.testId || !change.field || !change.proposedValue) continue;

                // Find the control by testId within this template's sheets
                const control = await db.sCSEMControl.findFirst({
                    where: {
                        testId: change.testId,
                        sheet: { templateId },
                    },
                });

                if (!control) {
                    console.warn(`Control ${change.testId} not found in template ${templateId}`);
                    continue;
                }

                // Build the update payload for the specific field
                const updateData: any = {
                    updateHighlight: true,
                    lastSyncedAt: new Date(),
                    lastSyncedVersion: review.benchmark.currentVersion,
                };

                // Map the field name to the actual DB column
                const fieldMap: Record<string, string> = {
                    testProcedures: "testProcedures",
                    expectedResults: "expectedResults",
                    remediationProcedure: "remediationProcedure",
                    description: "description",
                    rationale: "rationale",
                    impact: "impact",
                    sectionTitle: "sectionTitle",
                    findingStatement: "findingStatement",
                };

                const dbField = fieldMap[change.field];
                if (dbField) {
                    updateData[dbField] = change.proposedValue;
                }

                await db.sCSEMControl.update({
                    where: { id: control.id },
                    data: updateData,
                });

                appliedCount++;
            }

            // Create a changelog entry
            await db.sCSEMChangeLog.create({
                data: {
                    templateId,
                    version: review.benchmark.currentVersion,
                    changeDate: new Date(),
                    description: `CIS Benchmark update to v${review.benchmark.currentVersion}: ${appliedCount} control(s) updated. ${(review.suggestedChanges as any[]).map((c: any) => c.testId).join(", ")}`,
                    changedBy: session.user.name || session.user.email || "SkyShield Sync",
                    source: "cis_sync",
                },
            });

            // Update the template's tracked CIS version
            await db.sCSEMTemplate.update({
                where: { id: templateId },
                data: {
                    lastCisBenchmarkVersion: review.benchmark.currentVersion,
                    lastSyncedAt: new Date(),
                },
            });

            console.log(`Applied ${appliedCount} CIS updates to ${review.template.name}`);
        }

        // Log the action
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
                    status,
                },
            },
        });

        return NextResponse.json({ success: true, status });
    } catch (error) {
        console.error("Error updating SCSEM review:", error);
        return NextResponse.json(
            { error: "Failed to update SCSEM review" },
            { status: 500 }
        );
    }
}
