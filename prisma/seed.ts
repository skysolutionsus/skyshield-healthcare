import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create organization
  const org = await prisma.organization.upsert({
    where: { slug: "sky-solutions" },
    update: {},
    create: {
      name: "Sky Solutions",
      slug: "sky-solutions",
    },
  });

  console.log("Created organization:", org.name);

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
      await prisma.sCSEMTemplate.upsert({
        where: { id: scsem.name.replace(/\s+/g, "-").toLowerCase() },
        update: {
          name: scsem.name,
          category: scsem.category,
          filePath: scsem.file,
        },
        create: {
          id: scsem.name.replace(/\s+/g, "-").toLowerCase(),
          name: scsem.name,
          category: scsem.category,
          filePath: scsem.file,
        },
      });
    }
    console.log(`Loaded ${scsemIndex.length} SCSEM templates`);
  }

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
    { action: "SCSEM_ASSESSMENT", userId: complianceOfficer.id, resourceType: "scsem", metadata: { template: "Windows Server 2022" } },
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
