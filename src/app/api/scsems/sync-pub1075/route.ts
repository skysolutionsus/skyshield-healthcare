import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
});

// Publication 1075 revision history
// This is the authoritative source — update when IRS releases new revisions
const PUB_1075_CURRENT = {
    version: "Rev. 11-2021",
    title: "Tax Information Security Guidelines for Federal, State, and Local Agencies",
    effectiveDate: "2021-11-01",
    keyAreas: [
        "AC - Access Control",
        "AT - Awareness and Training",
        "AU - Audit and Accountability",
        "CA - Assessment, Authorization, and Monitoring",
        "CM - Configuration Management",
        "CP - Contingency Planning",
        "IA - Identification and Authentication",
        "IR - Incident Response",
        "MA - Maintenance",
        "MP - Media Protection",
        "PE - Physical and Environmental Protection",
        "PL - Planning",
        "PM - Program Management",
        "PS - Personnel Security",
        "RA - Risk Assessment",
        "SA - System and Services Acquisition",
        "SC - System and Communications Protection",
        "SI - System and Information Integrity",
    ],
};

export async function POST(request: Request) {
    try {
        // Auth: support CRON Bearer token or session
        const authHeader = request.headers.get("authorization");
        const expectedSecret = process.env.CRON_SECRET || "demo-secret";
        const isCron = authHeader === `Bearer ${expectedSecret}`;

        let session;
        if (!isCron) {
            session = await auth();
            if (!session?.user) {
                return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
            }
        }

        const orgId = session?.user
            ? (session.user as unknown as { organizationId: string }).organizationId
            : "system-cron";
        const userId = session?.user?.id || "system";

        // Get all templates
        const templates = await db.sCSEMTemplate.findMany({});

        if (templates.length === 0) {
            return NextResponse.json({ message: "No SCSEM templates found.", count: 0 });
        }

        let updatesGenerated = 0;

        for (const template of templates) {
            // Skip if already reviewed against this Pub 1075 version
            if (template.lastPub1075Version === PUB_1075_CURRENT.version) {
                console.log(`  ${template.name}: already reviewed against Pub 1075 ${PUB_1075_CURRENT.version}. Skipping.`);
                continue;
            }

            // Check for existing pending Pub 1075 review
            const existingReview = await db.sCSEMUpdateReview.findFirst({
                where: { templateId: template.id, status: "PENDING", source: "pub1075" },
            });
            if (existingReview) {
                console.log(`  ${template.name}: pending Pub 1075 review already exists. Skipping.`);
                continue;
            }

            // Load controls with NIST IDs for this template
            const controls = await db.sCSEMControl.findMany({
                where: {
                    sheet: { templateId: template.id },
                    nistId: { not: null },
                },
                select: {
                    id: true,
                    testId: true,
                    nistId: true,
                    nistControlName: true,
                    description: true,
                    testProcedures: true,
                    expectedResults: true,
                    criticality: true,
                    rationale: true,
                    remediationProcedure: true,
                },
                take: 40,
            });

            if (controls.length === 0) {
                console.log(`  ${template.name}: no controls with NIST IDs. Skipping.`);
                continue;
            }

            // Build control summary for the AI
            const controlSummary = controls.map((c: any) =>
                `${c.testId} | NIST: ${c.nistId} | ${c.nistControlName || "—"} | Criticality: ${c.criticality || "—"}\n  Procedure: ${(c.testProcedures || "").substring(0, 100)}`
            ).join("\n\n");

            const prompt = `You are an IRS Safeguards compliance expert analyzing SCSEM controls against IRS Publication 1075 (${PUB_1075_CURRENT.version}).

CONTEXT:
- SCSEM Template: ${template.name} (${template.category})
- Publication 1075: ${PUB_1075_CURRENT.title} (${PUB_1075_CURRENT.version}, effective ${PUB_1075_CURRENT.effectiveDate})
- Publication 1075 covers NIST 800-53 control families: ${PUB_1075_CURRENT.keyAreas.join(", ")}
- Previous Pub 1075 version reviewed: ${template.lastPub1075Version || "none"}

EXISTING SCSEM CONTROLS (sample with NIST mappings):
${controlSummary}

TASK: Review these controls for alignment with Publication 1075 ${PUB_1075_CURRENT.version}. Identify controls that may need updates to comply with the latest Pub 1075 requirements for protecting Federal Tax Information (FTI). Focus on:
1. Controls whose NIST mappings have updated guidance in Pub 1075
2. Test procedures that may not adequately address FTI protection requirements
3. Expected results that need to be tightened for Pub 1075 compliance
4. Missing remediation procedures for FTI-specific scenarios

Return ONLY valid JSON:
{
  "summary": "2-3 sentence summary of Pub 1075 alignment findings for this SCSEM",
  "changes": [
    {
      "testId": "MUST be an exact Test ID from the list above",
      "field": "testProcedures|expectedResults|remediationProcedure|description|rationale",
      "currentValue": "Brief summary of current value",
      "proposedValue": "Updated text aligned with Pub 1075 ${PUB_1075_CURRENT.version} requirements",
      "reason": "Why this change aligns with Pub 1075 (cite specific section if possible)"
    }
  ]
}

RULES:
- Only reference Test IDs from the EXISTING CONTROLS list
- Include 3-5 realistic changes focused on FTI protection
- Cite Pub 1075 sections where possible (e.g., "Pub 1075 Section 9.3.16.6")
- proposedValue must be complete replacement text
- Do NOT invent Test IDs
- Do NOT include markdown`;

            const message = await anthropic.messages.create({
                model: "claude-3-haiku-20240307",
                max_tokens: 2000,
                temperature: 0.3,
                system: "You generate precise IRS Publication 1075 compliance analysis for SCSEM controls.",
                messages: [{ role: "user", content: prompt }],
            });

            let responseText = message.content[0].type === "text" ? message.content[0].text : "";
            responseText = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();

            let payload;
            try {
                payload = JSON.parse(responseText);
            } catch {
                console.error(`  ${template.name}: failed to parse AI Pub 1075 response.`);
                continue;
            }

            // Validate testIds
            const existingTestIds = new Set(controls.map((c: any) => c.testId));
            const validChanges = (payload.changes || []).filter((c: any) => existingTestIds.has(c.testId));

            if (validChanges.length === 0) {
                console.log(`  ${template.name}: no valid Pub 1075 changes suggested. Skipping.`);
                continue;
            }

            // Store the review (no benchmarkId since this isn't CIS)
            const review = await db.sCSEMUpdateReview.create({
                data: {
                    templateId: template.id,
                    source: "pub1075",
                    status: "PENDING",
                    suggestedChanges: validChanges.map((c: any) => ({
                        testId: c.testId,
                        field: c.field,
                        currentValue: c.currentValue,
                        proposedValue: c.proposedValue,
                        reason: c.reason,
                    })),
                },
            });

            // Log the sync
            await db.auditLog.create({
                data: {
                    organizationId: orgId,
                    userId: userId,
                    action: "Pub 1075 Compliance Review",
                    resourceType: "SCSEMUpdateReview",
                    resourceId: review.id,
                    metadata: {
                        templateName: template.name,
                        pub1075Version: PUB_1075_CURRENT.version,
                        previousVersion: template.lastPub1075Version,
                        changesCount: validChanges.length,
                    },
                },
            });

            console.log(`  ✓ ${template.name}: ${validChanges.length} Pub 1075 changes proposed`);
            updatesGenerated++;

            // Limit to 5 templates per sync to avoid timeout
            if (updatesGenerated >= 5) break;
        }

        return NextResponse.json({
            success: true,
            message: `Generated Pub 1075 compliance reviews for ${updatesGenerated} template(s).`,
            pub1075Version: PUB_1075_CURRENT.version,
            count: updatesGenerated,
        });

    } catch (error: any) {
        console.error("Pub 1075 Sync error:", error);
        return NextResponse.json({
            error: `Failed to run Pub 1075 analysis: ${error.message || "Unknown Error"}`,
        }, { status: 500 });
    }
}
