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

            // Determine source-specific values
            const isPub1075 = (review as any).source === "pub1075";
            const versionLabel = isPub1075
                ? "Pub 1075 Rev. 11-2021"
                : review.benchmark?.currentVersion || "Unknown";

            // Create a changelog entry
            await db.sCSEMChangeLog.create({
                data: {
                    templateId,
                    version: versionLabel,
                    changeDate: new Date(),
                    description: `${isPub1075 ? "Pub 1075" : "CIS Benchmark"} update (${versionLabel}): ${appliedCount} control(s) updated. ${(review.suggestedChanges as any[]).map((c: any) => c.testId).join(", ")}`,
                    changedBy: session.user.name || session.user.email || "SkyShield Sync",
                    source: isPub1075 ? "pub1075_sync" : "cis_sync",
                },
            });

            // Update the template's tracked version
            const templateUpdate: any = { lastSyncedAt: new Date() };
            if (isPub1075) {
                templateUpdate.lastPub1075Version = "Rev. 11-2021";
            } else if (review.benchmark) {
                templateUpdate.lastCisBenchmarkVersion = review.benchmark.currentVersion;
            }

            await db.sCSEMTemplate.update({
                where: { id: templateId },
                data: templateUpdate,
            });

            console.log(`Applied ${appliedCount} ${isPub1075 ? "Pub 1075" : "CIS"} updates to ${review.template.name}`);
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
