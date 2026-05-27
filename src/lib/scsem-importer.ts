import { db } from "@/lib/db";
import { parseSCSEMFile } from "@/lib/xlsx-parser";

export async function importSCSEMTemplateWorkbook(templateId: string, filePath: string) {
    const parsed = parseSCSEMFile(filePath);

    await db.sCSEMTemplate.update({
        where: { id: templateId },
        data: {
            version: parsed.metadata.version,
            effectiveDate: parsed.metadata.effectiveDate,
            controlCount: parsed.totalControls,
        },
    });

    await db.sCSEMSheet.deleteMany({ where: { templateId } });
    await db.sCSEMChangeLog.deleteMany({ where: { templateId } });

    let importedSheets = 0;
    let importedControls = 0;
    let importedChangeLogs = 0;

    for (const sheet of parsed.sheets) {
        const dbSheet = await db.sCSEMSheet.create({
            data: {
                templateId,
                sheetName: sheet.sheetName,
                sheetType: sheet.sheetType,
                sheetIndex: sheet.sheetIndex,
                rawData: sheet.rawData as any,
            },
        });
        importedSheets++;

        if (sheet.controls.length > 0) {
            await db.sCSEMControl.createMany({
                data: sheet.controls.map((control) => ({
                    sheetId: dbSheet.id,
                    rowIndex: control.rowIndex,
                    testId: control.testId,
                    nistId: control.nistId,
                    nistControlName: control.nistControlName,
                    testMethod: control.testMethod,
                    sectionTitle: control.sectionTitle,
                    description: control.description,
                    testProcedures: control.testProcedures,
                    expectedResults: control.expectedResults,
                    actualResults: control.actualResults,
                    status: control.status,
                    findingStatement: control.findingStatement,
                    notesEvidence: control.notesEvidence,
                    criticality: control.criticality,
                    issueCode: control.issueCode,
                    issueCodeDescription: control.issueCodeDescription,
                    cisBenchmarkRef: control.cisBenchmarkRef,
                    recommendationNum: control.recommendationNum,
                    rationale: control.rationale,
                    impact: control.impact,
                    remediationProcedure: control.remediationProcedure,
                    remediationStatement: control.remediationStatement,
                    capRequestStatement: control.capRequestStatement,
                    riskRating: control.riskRating,
                    extraColumns: control.extraColumns as any,
                })),
            });
            importedControls += sheet.controls.length;
        }

        if (sheet.changeLogEntries.length > 0) {
            await db.sCSEMChangeLog.createMany({
                data: sheet.changeLogEntries.map((entry) => ({
                    templateId,
                    version: entry.version,
                    changeDate: entry.changeDate,
                    description: entry.description,
                    changedBy: entry.changedBy,
                    source: "xlsx_import",
                })),
            });
            importedChangeLogs += sheet.changeLogEntries.length;
        }
    }

    return {
        importedSheets,
        importedControls,
        importedChangeLogs,
    };
}
