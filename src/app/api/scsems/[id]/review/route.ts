import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { detectPub1075Version } from "@/lib/knowledge/ingest";
import * as fs from "fs";
import * as path from "path";

function currentPub1075Version(): string {
    const pub1075Path = path.join(process.cwd(), "data", "pub1075", "p1075-full-text.md");
    if (!fs.existsSync(pub1075Path)) return "Pub 1075";
    return detectPub1075Version(fs.readFileSync(pub1075Path, "utf8"));
}

function generateNextTestId(existingTestIds: string[], fallbackPrefix: string): string {
    let selectedPrefix = `${fallbackPrefix}-`;
    let selectedWidth = 3;
    let maxNumber = 0;
    const prefixCounts = new Map<string, number>();

    for (const testId of existingTestIds) {
        const match = testId.match(/^(.*?)(\d+)$/);
        if (!match) continue;
        const prefix = match[1];
        prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }

    const mostCommonPrefix = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (mostCommonPrefix) selectedPrefix = mostCommonPrefix;

    for (const testId of existingTestIds) {
        const match = testId.match(/^(.*?)(\d+)$/);
        if (!match || match[1] !== selectedPrefix) continue;
        selectedWidth = Math.max(selectedWidth, match[2].length);
        maxNumber = Math.max(maxNumber, Number.parseInt(match[2], 10));
    }

    return `${selectedPrefix}${String(maxNumber + 1).padStart(selectedWidth, "0")}`;
}

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
        const { reviewId, status, suggestedChanges } = body;

        if (!reviewId || !status) {
            return NextResponse.json({ error: "Missing fields" }, { status: 400 });
        }

        const review = await db.sCSEMUpdateReview.update({
            where: { id: reviewId },
            data: {
                status,
                ...(status === "ACCEPTED" && Array.isArray(suggestedChanges)
                    ? { suggestedChanges }
                    : {}),
            },
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
            let addedCount = 0;

            const primarySheet = await db.sCSEMSheet.findFirst({
                where: { templateId, sheetType: "test_cases" },
                orderBy: { sheetIndex: "asc" },
                include: {
                    controls: {
                        select: { testId: true, rowIndex: true },
                        orderBy: { rowIndex: "asc" },
                    },
                },
            });

            for (const change of changes) {
                if (change.action === "addControl") {
                    if (!primarySheet || !change.newControl) continue;

                    const existingTestIds = primarySheet.controls.map((control) => control.testId);
                    const fallbackPrefix = review.template.name
                        .replace(/^Safeguards-SCSEM\s*/i, "")
                        .replace(/[^A-Z0-9]+/gi, "")
                        .slice(0, 10)
                        .toUpperCase() || "SCSEM";
                    const newTestId = generateNextTestId(existingTestIds, fallbackPrefix);
                    const maxRowIndex = primarySheet.controls.reduce(
                        (max, control) => Math.max(max, control.rowIndex),
                        0
                    );
                    const newControl = change.newControl;

                    await db.sCSEMControl.create({
                        data: {
                            sheetId: primarySheet.id,
                            rowIndex: maxRowIndex + addedCount + 1,
                            testId: newTestId,
                            nistId: newControl.nistId || null,
                            nistControlName: newControl.nistControlName || null,
                            testMethod: newControl.testMethod || "Manual",
                            sectionTitle: newControl.sectionTitle || change.proposedValue || null,
                            description: newControl.description || null,
                            testProcedures: newControl.testProcedures || null,
                            expectedResults: newControl.expectedResults || null,
                            actualResults: null,
                            status: null,
                            findingStatement: null,
                            notesEvidence: null,
                            criticality: newControl.criticality || "Moderate",
                            issueCode: null,
                            issueCodeDescription: null,
                            cisBenchmarkRef: newControl.cisBenchmarkRef || null,
                            recommendationNum: newControl.recommendationNum || change.sourceEvidence?.cisRecommendation || null,
                            rationale: newControl.rationale || null,
                            impact: newControl.impact || null,
                            remediationProcedure: newControl.remediationProcedure || null,
                            remediationStatement: null,
                            capRequestStatement: null,
                            riskRating: null,
                            extraColumns: {
                                source: "cis_sync",
                                originalSuggestedTestId: change.testId || null,
                                reason: change.reason || null,
                                confidence: change.confidence || null,
                                sourceEvidence: change.sourceEvidence || null,
                            },
                            updateHighlight: true,
                            lastSyncedAt: new Date(),
                            lastSyncedVersion: review.benchmark?.currentVersion || "synced",
                        },
                    });

                    primarySheet.controls.push({ testId: newTestId, rowIndex: maxRowIndex + addedCount + 1 });
                    addedCount++;
                    appliedCount++;
                    continue;
                }

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
                    lastSyncedVersion: review.benchmark?.currentVersion || "synced",
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
                ? `Pub 1075 ${currentPub1075Version()}`
                : review.benchmark?.currentVersion || "Unknown";

            // Create a changelog entry
            await db.sCSEMChangeLog.create({
                data: {
                    templateId,
                    version: versionLabel,
                    changeDate: new Date(),
                    description: `${isPub1075 ? "Pub 1075" : "CIS Benchmark"} update (${versionLabel}): ${appliedCount} control(s) applied (${addedCount} new). ${(review.suggestedChanges as any[]).map((c: any) => c.testId).join(", ")}`,
                    changedBy: session.user.name || session.user.email || "SkyShield Sync",
                    source: isPub1075 ? "pub1075_sync" : "cis_sync",
                },
            });

            // Update the template's tracked version
            const templateUpdate: any = { lastSyncedAt: new Date() };
            if (isPub1075) {
                templateUpdate.lastPub1075Version = currentPub1075Version();
            } else if (review.benchmark) {
                templateUpdate.lastCisBenchmarkVersion = review.benchmark?.currentVersion || versionLabel;
            }

            if (addedCount > 0) {
                templateUpdate.controlCount = { increment: addedCount };
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
                    benchmarkVersion: review.benchmark?.currentVersion || "N/A",
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
