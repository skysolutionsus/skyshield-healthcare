import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCISToken, fetchAllBenchmarks } from "@/lib/cis-api";
import { isAdminRole } from "@/lib/roles";
import { generateBifrostText, getConfiguredBifrostModel } from "@/lib/ai/bifrost";

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

        // Step 1: Authenticate with CIS WorkBench API
        let cisToken = "";
        try {
            console.log("Authenticating with CIS WorkBench via license.xml...");
            cisToken = await getCISToken();
            console.log(`CIS Auth OK. Token: ${cisToken.substring(0, 15)}...`);
        } catch (error: any) {
            console.error("CIS Auth failed:", error.message);
            return NextResponse.json({ error: "CIS authentication failed" }, { status: 502 });
        }

        // Step 2: Fetch all CIS benchmarks
        console.log("Fetching CIS benchmark catalog...");
        const allBenchmarks = await fetchAllBenchmarks(cisToken);
        console.log(`Received ${allBenchmarks.length} benchmarks from CIS.`);

        // Step 3: Find SCSEM templates that need updates
        const templates = await db.sCSEMTemplate.findMany({
            where: { cisTechnology: { not: null } },
        });

        if (templates.length === 0) {
            return NextResponse.json({ message: "No templates with CIS technology mapping.", count: 0 });
        }

        let updatesGenerated = 0;

        for (const template of templates) {
            const templateTech = (template.cisTechnology || "").toLowerCase();

            // Find the best matching CIS benchmark
            const matched = allBenchmarks.find(b =>
                b.benchmarkTitle.toLowerCase().includes(templateTech) ||
                templateTech.includes(b.benchmarkTitle.toLowerCase().replace("cis ", "").replace(" benchmark", "").trim())
            ) || allBenchmarks.find(b =>
                templateTech.split(" ").some(word => word.length > 3 && b.benchmarkTitle.toLowerCase().includes(word))
            );

            if (!matched) {
                console.log(`  No CIS match for "${template.cisTechnology}". Skipping.`);
                continue;
            }

            const cisBenchmarkVersion = matched.benchmarkVersion;

            // Skip if we're already on this version
            if (template.lastCisBenchmarkVersion === cisBenchmarkVersion) {
                console.log(`  ${template.name}: already on CIS v${cisBenchmarkVersion}. Skipping.`);
                continue;
            }

            // Check for existing pending review
            const existingReview = await db.sCSEMUpdateReview.findFirst({
                where: { templateId: template.id, status: "PENDING" },
            });
            if (existingReview) {
                console.log(`  ${template.name}: pending review already exists. Skipping.`);
                continue;
            }

            // Step 4: Load actual SCSEM controls for this template
            const controls = await db.sCSEMControl.findMany({
                where: { sheet: { templateId: template.id } },
                select: {
                    id: true,
                    testId: true,
                    nistId: true,
                    nistControlName: true,
                    testMethod: true,
                    sectionTitle: true,
                    description: true,
                    testProcedures: true,
                    expectedResults: true,
                    criticality: true,
                    cisBenchmarkRef: true,
                    recommendationNum: true,
                    rationale: true,
                    remediationProcedure: true,
                },
                take: 50, // Sample to keep prompt manageable
            });

            if (controls.length === 0) {
                console.log(`  ${template.name}: no controls loaded. Skipping.`);
                continue;
            }

            // Build a concise summary of existing controls
            const controlSummary = controls.map(c =>
                `${c.testId} | NIST: ${c.nistId || "—"} | CIS Ref: ${c.cisBenchmarkRef || "—"} | ${c.nistControlName || c.sectionTitle || "—"} | Criticality: ${c.criticality || "—"}`
            ).join("\n");

            // Step 5: Ask Bifrost to generate grounded update suggestions
            const prompt = `You are a cybersecurity compliance expert analyzing CIS Benchmark updates for IRS Safeguards SCSEMs.

CONTEXT:
- Technology: ${template.cisTechnology}
- Current SCSEM version: ${template.version || "unknown"}
- CIS Benchmark title: ${matched.benchmarkTitle}
- CIS Benchmark NEW version: ${cisBenchmarkVersion}
- CIS Benchmark status: ${matched.benchmarkStatus?.status || "published"} (${matched.benchmarkStatus?.statusDate || "recent"})
- Previous CIS version tracked: ${template.lastCisBenchmarkVersion || "none"}
- Assessment type: ${matched.assessmentStatus || "unknown"}
- Profiles: ${matched.profile?.map(p => p.profileTitle).join(", ") || "N/A"}

EXISTING SCSEM CONTROLS (sample):
${controlSummary}

TASK: Based on the CIS Benchmark version update, identify which EXISTING controls need updates. These should reflect realistic changes that occur between CIS Benchmark versions (e.g., tighter password requirements, new audit rules, deprecated settings, added controls).

Return ONLY valid JSON with this structure:
{
  "summary": "2-3 sentence summary of what changed in this CIS version update",
  "changes": [
    {
      "testId": "MUST be an exact Test ID from the list above",
      "field": "testProcedures|expectedResults|remediationProcedure|description|rationale",
      "currentValue": "Brief summary of what the control currently says",
      "proposedValue": "The updated text reflecting the new CIS benchmark requirements",
      "reason": "Why this change is needed (e.g., 'CIS v${cisBenchmarkVersion} requires...')"
    }
  ]
}

RULES:
- Only reference Test IDs that appear in the EXISTING SCSEM CONTROLS list above
- Include 3-5 realistic changes
- Each change must specify which field is being updated
- proposedValue must be the FULL replacement text for that field, not a diff
- Do NOT invent new Test IDs
- Do NOT include markdown formatting`;

            let responseText = await generateBifrostText({
                model: getConfiguredBifrostModel("BIFROST_SCSEM_MODEL"),
                maxTokens: 1400,
                temperature: 0.2,
                system: "You generate precise, realistic CIS benchmark update payloads referencing real control IDs.",
                prompt,
            });
            responseText = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();

            let payload;
            try {
                payload = JSON.parse(responseText);
            } catch {
                console.error(`  ${template.name}: failed to parse AI response.`);
                continue;
            }

            // Validate that suggested testIds actually exist
            const existingTestIds = new Set(controls.map(c => c.testId));
            const validChanges = (payload.changes || []).filter((c: any) => existingTestIds.has(c.testId));

            if (validChanges.length === 0) {
                console.log(`  ${template.name}: AI suggested no valid changes. Skipping.`);
                continue;
            }

            // Step 6: Store benchmark + review
            const benchmark = await db.cISBenchmarkVersion.create({
                data: {
                    technology: template.cisTechnology || "Unknown",
                    currentVersion: cisBenchmarkVersion,
                    releaseDate: (() => {
                        const d = new Date(matched.benchmarkStatus?.statusDate || new Date().toISOString());
                        return isNaN(d.getTime()) ? new Date() : d;
                    })(),
                    changesSummary: payload.summary || `CIS ${template.cisTechnology} updated to v${cisBenchmarkVersion}`,
                },
            });

            const review = await db.sCSEMUpdateReview.create({
                data: {
                    templateId: template.id,
                    benchmarkId: benchmark.id,
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
                    action: "CIS Benchmark Sync",
                    resourceType: "SCSEMUpdateReview",
                    resourceId: review.id,
                    metadata: {
                        templateName: template.name,
                        technology: benchmark.technology,
                        version: benchmark.currentVersion,
                        previousVersion: template.lastCisBenchmarkVersion,
                        changesCount: validChanges.length,
                    },
                },
            });

            console.log(`  ✓ ${template.name}: ${validChanges.length} changes proposed (CIS ${template.lastCisBenchmarkVersion || "none"} → v${cisBenchmarkVersion})`);
            updatesGenerated++;
        }

        return NextResponse.json({
            success: true,
            message: `Synced ${updatesGenerated} template(s) with CIS benchmark updates.`,
            count: updatesGenerated,
        });

    } catch (error: any) {
        console.error("CIS Sync error:", error);
        return NextResponse.json({
            error: `Failed to sync CIS benchmarks: ${error.message || "Unknown Error"}`,
        }, { status: 500 });
    }
}
