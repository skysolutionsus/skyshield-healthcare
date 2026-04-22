import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import Anthropic from "@anthropic-ai/sdk";
import { isAdminRole } from "@/lib/roles";
import * as fs from "fs";
import * as path from "path";

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
});

const PUB_1075_CURRENT = {
    version: "Rev. 11-2021",
    title: "Tax Information Security Guidelines for Federal, State, and Local Agencies",
    effectiveDate: "2021-11-01",
};

/**
 * Extracts relevant sections from the Pub 1075 full-text document
 * based on the NIST control families referenced by the SCSEM controls.
 * 
 * For example, if controls reference AC-2, AC-7, IA-5, this will extract
 * the actual Pub 1075 text for those specific controls.
 */
function extractPub1075Sections(nistIds: string[]): string {
    const pub1075Path = path.join(process.cwd(), "data", "pub1075", "p1075-full-text.md");

    try {
        const fullText = fs.readFileSync(pub1075Path, "utf8");
        const lines = fullText.split("\n");

        // Collect unique NIST control prefixes (e.g., "AC-2", "IA-5", "AU-6")
        const controlPrefixes = new Set<string>();
        for (const nistId of nistIds) {
            if (!nistId) continue;
            // Extract base control ID: "AC-2(1)" → "AC-2", "IA-5" → "IA-5"
            const match = nistId.match(/^([A-Z]{2}-\d+)/);
            if (match) {
                controlPrefixes.add(match[1]);
            }
        }

        if (controlPrefixes.size === 0) return "";

        // Build regex patterns to find section headers for these controls
        // Pub 1075 uses formats like "AC-2 Account Management" or "AC-2:" etc.
        const sections: string[] = [];
        let currentSection = "";
        let capturing = false;
        let capturedCount = 0;
        const maxCharsPerSection = 2000;
        const maxTotalChars = 12000; // Keep under token limit
        let totalChars = 0;

        for (let i = 0; i < lines.length && totalChars < maxTotalChars; i++) {
            const line = lines[i];

            // Check if this line starts a new NIST control section
            const sectionMatch = line.match(/^([A-Z]{2}-\d+)[\s:]/);

            if (sectionMatch) {
                // Save previous section if it was one we wanted
                if (capturing && currentSection.length > 0) {
                    sections.push(currentSection.trim());
                    totalChars += currentSection.length;
                    capturedCount++;
                }

                // Check if this new section is one we need
                if (controlPrefixes.has(sectionMatch[1]) && totalChars < maxTotalChars) {
                    capturing = true;
                    currentSection = line + "\n";
                } else {
                    capturing = false;
                    currentSection = "";
                }
            } else if (capturing) {
                // Continue capturing if we haven't exceeded per-section limit
                if (currentSection.length < maxCharsPerSection) {
                    currentSection += line + "\n";
                }
            }
        }

        // Don't forget the last section
        if (capturing && currentSection.length > 0) {
            sections.push(currentSection.trim());
        }

        if (sections.length === 0) return "";

        return `\n\n--- ACTUAL IRS PUBLICATION 1075 (${PUB_1075_CURRENT.version}) EXCERPTS ---\nThe following are the EXACT requirements from Pub 1075 for the referenced NIST controls:\n\n${sections.join("\n\n---\n\n")}`;

    } catch (err) {
        console.warn("Could not read Pub 1075 full text:", err);
        return "";
    }
}

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
            if (!isAdminRole((session.user as unknown as { role: string }).role)) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

            // Extract actual Pub 1075 sections for the referenced NIST IDs
            const nistIds = controls.map((c: any) => c.nistId).filter(Boolean);
            const pub1075Content = extractPub1075Sections(nistIds);
            const hasPub1075Content = pub1075Content.length > 0;

            console.log(`  ${template.name}: loaded ${controls.length} controls, extracted ${hasPub1075Content ? "real" : "no"} Pub 1075 content`);

            // Build control summary
            const controlSummary = controls.map((c: any) =>
                `${c.testId} | NIST: ${c.nistId} | ${c.nistControlName || "—"} | Criticality: ${c.criticality || "—"}\n  Procedure: ${(c.testProcedures || "").substring(0, 150)}\n  Expected: ${(c.expectedResults || "").substring(0, 150)}`
            ).join("\n\n");

            const prompt = `You are an IRS Safeguards compliance expert. You have been given ACTUAL EXCERPTS from IRS Publication 1075 (${PUB_1075_CURRENT.version}) below. Use these excerpts as the authoritative source.

SCSEM TEMPLATE: ${template.name} (${template.category})

EXISTING SCSEM CONTROLS:
${controlSummary}
${pub1075Content}

TASK: Compare each SCSEM control against the ACTUAL Pub 1075 requirements provided above. Identify controls where:
1. The test procedure does not fully test what Pub 1075 requires for that NIST control
2. The expected result does not match Pub 1075's specific FTI protection requirements
3. The remediation procedure is missing or incomplete per Pub 1075
4. The description needs to reference specific Pub 1075 language

${hasPub1075Content ? "IMPORTANT: You MUST cite the actual Pub 1075 text from the excerpts above. Do not make up requirements — only suggest changes based on what is explicitly stated in the excerpts." : ""}

Return ONLY valid JSON:
{
  "summary": "2-3 sentence summary citing specific Pub 1075 sections that affect this SCSEM",
  "changes": [
    {
      "testId": "MUST be an exact Test ID from the EXISTING CONTROLS list",
      "field": "testProcedures|expectedResults|remediationProcedure|description|rationale",
      "currentValue": "Brief summary of what the control currently says",
      "proposedValue": "Updated text aligned with the ACTUAL Pub 1075 excerpts provided",
      "reason": "Cite the specific Pub 1075 section and quote the relevant requirement"
    }
  ]
}

RULES:
- Only reference Test IDs from the EXISTING CONTROLS list
- Include 3-5 changes grounded in the actual Pub 1075 text
- proposedValue must be complete replacement text for that field
- reason MUST cite a specific Pub 1075 section
- Do NOT invent Test IDs or Pub 1075 content`;

            const message = await anthropic.messages.create({
                model: "claude-3-haiku-20240307",
                max_tokens: 2500,
                temperature: 0.2, // Lower temperature for more precise compliance work
                system: "You are a precise IRS Publication 1075 compliance analyst. You only cite requirements that appear in the actual document excerpts provided to you.",
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

            // Store the review
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
                        usedRealPub1075Content: hasPub1075Content,
                    },
                },
            });

            console.log(`  ✓ ${template.name}: ${validChanges.length} Pub 1075 changes proposed (${hasPub1075Content ? "grounded in real doc" : "general knowledge"})`);
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
