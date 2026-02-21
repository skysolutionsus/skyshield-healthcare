import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Clean up ALL users that aren't in our current seed list
  const keepEmails = [
    "james@skysolutions.com",
    "mconklin@skysolutions.com",
    "jcambra@skysolutions.com",
    "nmatta@skysolutions.com",
  ];

  // Wipe dependent tables first to avoid FK constraint errors
  await prisma.auditLog.deleteMany({});
  await prisma.incidentActivity.deleteMany({});
  await prisma.incident.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.conversation.deleteMany({});

  const deleted = await prisma.user.deleteMany({
    where: { email: { notIn: keepEmails } },
  });
  if (deleted.count > 0) {
    console.log(`Removed ${deleted.count} old/stale users`);
  }

  // Update existing org if it has the old slug, otherwise create
  const existingOrg = await prisma.organization.findFirst({
    where: { slug: { in: ["safeguards-division", "sky-solutions"] } },
  });

  let org;
  if (existingOrg) {
    org = await prisma.organization.update({
      where: { id: existingOrg.id },
      data: { name: "Sky Solutions", slug: "sky-solutions" },
    });
  } else {
    org = await prisma.organization.create({
      data: { name: "Sky Solutions", slug: "sky-solutions" },
    });
  }

  console.log("Organization:", org.name);

  // Create admin user (primary demo account)
  const adminPassword = await hash("SkyShield2026!", 12);
  const admin = await prisma.user.upsert({
    where: { email: "james@skysolutions.com" },
    update: {},
    create: {
      email: "james@skysolutions.com",
      name: "James Galang",
      passwordHash: adminPassword,
      role: "ADMIN",
      organizationId: org.id,
    },
  });

  console.log("Created admin user:", admin.email);

  // Create compliance officer
  const coPassword = await hash("Compliance123!@#$", 12);
  const complianceOfficer = await prisma.user.upsert({
    where: { email: "mconklin@skysolutions.com" },
    update: {},
    create: {
      email: "mconklin@skysolutions.com",
      name: "Michael Conklin",
      passwordHash: coPassword,
      role: "COMPLIANCE_OFFICER",
      organizationId: org.id,
    },
  });

  console.log("Created compliance officer:", complianceOfficer.email);

  // Create auditor
  const auditorPassword = await hash("Auditor123!@#$", 12);
  const auditor = await prisma.user.upsert({
    where: { email: "jcambra@skysolutions.com" },
    update: {},
    create: {
      email: "jcambra@skysolutions.com",
      name: "Jared Cambra",
      passwordHash: auditorPassword,
      role: "AUDITOR",
      organizationId: org.id,
    },
  });

  console.log("Created auditor:", auditor.email);

  // Create viewer
  const viewerPassword = await hash("Viewer123!@#$", 12);
  await prisma.user.upsert({
    where: { email: "nmatta@skysolutions.com" },
    update: {},
    create: {
      email: "nmatta@skysolutions.com",
      name: "Nitin Matta",
      passwordHash: viewerPassword,
      role: "VIEWER",
      organizationId: org.id,
    },
  });

  console.log("Created viewer user");

  // Load SCSEM templates from index
  const scsemIndexPath = path.join(process.cwd(), "data", "scsem-index.json");
  if (fs.existsSync(scsemIndexPath)) {
    const scsemIndex = JSON.parse(fs.readFileSync(scsemIndexPath, "utf-8"));

    for (const scsem of scsemIndex) {
      let cisTech = null;
      if (scsem.name.includes("Windows Server 2022")) cisTech = "Windows Server 2022";
      else if (scsem.name.includes("Windows Server 2019")) cisTech = "Windows Server 2019";
      else if (scsem.name.includes("Windows 10")) cisTech = "Windows 10";
      else if (scsem.name.includes("Windows 11")) cisTech = "Windows 11";
      else if (scsem.name.includes("RHEL")) cisTech = "Red Hat Enterprise Linux";
      else if (scsem.name.includes("Oracle")) cisTech = "Oracle Database";
      else if (scsem.name.includes("Cisco")) cisTech = "Cisco Network Devices";

      await prisma.sCSEMTemplate.upsert({
        where: { id: scsem.name.replace(/\s+/g, "-").toLowerCase() },
        update: {
          name: scsem.name,
          category: scsem.category,
          filePath: scsem.file,
          cisTechnology: cisTech,
        },
        create: {
          id: scsem.name.replace(/\s+/g, "-").toLowerCase(),
          name: scsem.name,
          category: scsem.category,
          filePath: scsem.file,
          cisTechnology: cisTech,
        },
      });
    }
    console.log(`Loaded ${scsemIndex.length} SCSEM templates`);

    // Import XLSX data for each template
    console.log("\nParsing SCSEM XLSX files...");
    const { parseSCSEMFile } = await import("../src/lib/xlsx-parser");

    let totalControlsImported = 0;
    let totalChangeLogsImported = 0;

    for (const scsem of scsemIndex) {
      const templateId = scsem.name.replace(/\s+/g, "-").toLowerCase();

      try {
        const parsed = parseSCSEMFile(scsem.file);

        // Update template with metadata from Dashboard
        await prisma.sCSEMTemplate.update({
          where: { id: templateId },
          data: {
            version: parsed.metadata.version,
            effectiveDate: parsed.metadata.effectiveDate,
            controlCount: parsed.totalControls,
          },
        });

        // Clear existing sheets/controls for this template (idempotent re-seed)
        await prisma.sCSEMSheet.deleteMany({ where: { templateId } });
        await prisma.sCSEMChangeLog.deleteMany({ where: { templateId } });

        // Import each sheet
        for (const sheet of parsed.sheets) {
          const dbSheet = await prisma.sCSEMSheet.create({
            data: {
              templateId,
              sheetName: sheet.sheetName,
              sheetType: sheet.sheetType,
              sheetIndex: sheet.sheetIndex,
              rawData: sheet.rawData as any,
            },
          });

          // Import controls for test_cases sheets
          if (sheet.controls.length > 0) {
            await prisma.sCSEMControl.createMany({
              data: sheet.controls.map((c) => ({
                sheetId: dbSheet.id,
                rowIndex: c.rowIndex,
                testId: c.testId,
                nistId: c.nistId,
                nistControlName: c.nistControlName,
                testMethod: c.testMethod,
                description: c.description,
                testProcedures: c.testProcedures,
                expectedResults: c.expectedResults,
                actualResults: c.actualResults,
                status: c.status,
                notesEvidence: c.notesEvidence,
                extraColumns: c.extraColumns as any,
              })),
            });
            totalControlsImported += sheet.controls.length;
          }

          // Import changelog entries
          if (sheet.changeLogEntries.length > 0) {
            await prisma.sCSEMChangeLog.createMany({
              data: sheet.changeLogEntries.map((cl) => ({
                templateId,
                version: cl.version,
                changeDate: cl.changeDate,
                description: cl.description,
                changedBy: cl.changedBy,
                source: "xlsx_import",
              })),
            });
            totalChangeLogsImported += sheet.changeLogEntries.length;
          }
        }

        console.log(`  ✓ ${scsem.name}: ${parsed.totalControls} controls, ${parsed.sheets.length} sheets`);
      } catch (err: any) {
        console.error(`  ✗ ${scsem.name}: ${err.message}`);
      }
    }

    console.log(`\nImported ${totalControlsImported} total controls and ${totalChangeLogsImported} changelog entries`);
  }

  console.log("SCSEM data import complete");

  // Create sample incidents
  const incidents = [
    {
      title: "Unauthorized FTI access attempt detected",
      description:
        "System logs indicate an unauthorized access attempt to FTI database from an unrecognized IP address. Access was blocked by firewall rules.",
      type: "UNAUTHORIZED_ACCESS" as const,
      severity: "HIGH" as const,
      status: "INVESTIGATING" as const,
      affectedSystems: "FTI Database Server",
      relatedSections: [
        { section: "Section 9.3.16.6", text: "Access Control" },
        { section: "Section 10.1", text: "Incident Response" },
      ],
    },
    {
      title: "PII detected in AI chat input",
      description:
        "Automated PII detection triggered when a user attempted to paste what appeared to be SSN data into the AI chat. The message was blocked and not transmitted.",
      type: "AUTO_GENERATED" as const,
      severity: "MEDIUM" as const,
      status: "OPEN" as const,
      affectedSystems: "AI Chat Interface",
      relatedSections: [
        { section: "Section 3.2", text: "Handling of FTI" },
      ],
    },
    {
      title: "Expired CIS Benchmark - Windows Server 2022",
      description:
        "CIS Benchmark for Windows Server 2022 has been updated. Current SCSEM assessment may need review against the new benchmark version.",
      type: "POLICY_VIOLATION" as const,
      severity: "LOW" as const,
      status: "OPEN" as const,
      affectedSystems: "Windows Server 2022 SCSEM",
      relatedSections: [
        { section: "Section 9.3", text: "Technical Security Controls" },
      ],
    },
  ];

  for (const incident of incidents) {
    await prisma.incident.create({
      data: {
        organizationId: org.id,
        createdById: complianceOfficer.id,
        assignedToId: complianceOfficer.id,
        ...incident,
      },
    });
  }

  console.log(`Created ${incidents.length} sample incidents`);

  // Create sample audit logs
  const auditActions = [
    { action: "LOGIN", userId: admin.id, resourceType: "session" },
    { action: "AI_QUERY", userId: complianceOfficer.id, resourceType: "chat", metadata: { questionLength: 45 } },
    { action: "INCIDENT_CREATE", userId: complianceOfficer.id, resourceType: "incident" },
    { action: "LOGIN", userId: auditor.id, resourceType: "session" },
    { action: "USER_CREATE", userId: admin.id, resourceType: "user", metadata: { email: "nmatta@skysolutions.com" } },
  ];

  for (const log of auditActions) {
    await prisma.auditLog.create({
      data: {
        organizationId: org.id,
        userId: log.userId,
        action: log.action,
        resourceType: log.resourceType,
        metadata: log.metadata || undefined,
        ipAddress: "10.0.1.1",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });
  }

  console.log(`Created ${auditActions.length} audit log entries`);

  // Create a sample conversation
  const conversation = await prisma.conversation.create({
    data: {
      userId: complianceOfficer.id,
      title: "FTI encryption requirements",
      bookmarked: true,
    },
  });

  await prisma.message.createMany({
    data: [
      {
        conversationId: conversation.id,
        role: "user",
        content: "What are the requirements for encrypting FTI data at rest?",
      },
      {
        conversationId: conversation.id,
        role: "assistant",
        content:
          "Based on Publication 1075, FTI data at rest must be encrypted using FIPS 140-2 validated encryption modules. Here are the key requirements:\n\n1. **Encryption Standard**: All FTI must be encrypted using NIST-approved algorithms (e.g., AES-256) [Section 9.3.16.2]\n\n2. **Key Management**: Encryption keys must be managed in accordance with NIST SP 800-57 [Section 9.3.16.2]\n\n3. **Full Disk Encryption**: When FTI is stored on portable devices or media, full disk encryption is required [Section 9.3.16.2]\n\n4. **Database Encryption**: FTI stored in databases must use Transparent Data Encryption (TDE) or column-level encryption [Section 9.3.16.2]\n\n5. **Backup Media**: All backup media containing FTI must also be encrypted [Section 9.3.7.1]",
        citations: [
          { section: "Section 9.3.16.2", text: "Encryption requirements for FTI" },
          { section: "Section 9.3.7.1", text: "Backup media protection" },
        ],
      },
    ],
  });

  console.log("Created sample conversation");
  console.log("\nSeed complete! Login credentials:");
  console.log("  Admin:      james@skysolutions.com / SkyShield2026!");
  console.log("  Compliance: mconklin@skysolutions.com / Compliance123!@#$");
  console.log("  Auditor:    jcambra@skysolutions.com / Auditor123!@#$");
  console.log("  Viewer:     nmatta@skysolutions.com / Viewer123!@#$");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
