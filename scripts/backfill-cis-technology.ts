import * as fs from "fs";
import * as path from "path";
import { db } from "@/lib/db";

type IndexEntry = { file: string; category: string; name: string };

const rules: [RegExp, string][] = [
  [/windows server 2022/i, "Windows Server 2022"],
  [/windows server 2019/i, "Windows Server 2019"],
  [/windows server 2016/i, "Windows Server 2016"],
  [/windows 11/i, "Windows 11"],
  [/windows 10/i, "Windows 10"],
  [/\brhel\b|red hat enterprise/i, "Red Hat Enterprise Linux"],
  [/oracle solaris|\bsolaris\b/i, "Oracle Solaris"],
  [/oracle linux|\boel\b/i, "Oracle Linux"],
  [/oracle database|\boracle v\d/i, "Oracle Database"],
  [/cisco asa/i, "Cisco ASA Firewall"],
  [/cisco ios|cisco network|switch_router|\bcisco\b/i, "Cisco IOS"],
  [/check ?point/i, "Check Point Firewall"],
  [/palo alto/i, "Palo Alto Firewall"],
  [/fortigate|fortinet/i, "Fortinet FortiGate"],
  [/\bmysql\b/i, "MySQL"],
  [/sql server/i, "Microsoft SQL Server"],
  [/mongodb/i, "MongoDB"],
  [/\bdb2\b/i, "IBM DB2"],
  [/\baix\b/i, "IBM AIX"],
  [/\bdebian\b/i, "Debian Linux"],
  [/hp-?ux/i, "HP-UX"],
  [/mac ?os ?x|\bmacos\b/i, "macOS"],
  [/apache/i, "Apache HTTP Server"],
  [/\bnginx\b/i, "NGINX"],
  [/\biis\b/i, "Microsoft IIS"],
];

function detect(name: string): string | null {
  for (const [re, tech] of rules) {
    if (re.test(name)) return tech;
  }
  return null;
}

function slugify(name: string): string {
  return name.replace(/\s+/g, "-").toLowerCase();
}

function loadIndex(): IndexEntry[] {
  const candidates = [
    path.join(process.cwd(), "data", "scsem-index.json"),
    path.join(__dirname, "..", "data", "scsem-index.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`  Reading SCSEM index from ${p}`);
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  }
  console.warn(
    `  SCSEM index not found. Checked: ${candidates.join(", ")}. ` +
      `Skipping template creation; only existing templates will be backfilled.`
  );
  return [];
}

async function main() {
  const index = loadIndex();

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const entry of index) {
    const id = slugify(entry.name);
    const cisTechnology = detect(entry.name);

    const existing = await db.sCSEMTemplate.findUnique({ where: { id } });

    if (!existing) {
      await db.sCSEMTemplate.create({
        data: {
          id,
          name: entry.name,
          category: entry.category,
          filePath: entry.file,
          cisTechnology,
        },
      });
      created++;
      console.log(`  + created ${entry.name}${cisTechnology ? ` [${cisTechnology}]` : ""}`);
    } else if (existing.cisTechnology !== cisTechnology) {
      await db.sCSEMTemplate.update({
        where: { id },
        data: { cisTechnology },
      });
      updated++;
      console.log(
        `  ~ ${entry.name}: ${existing.cisTechnology || "null"} -> ${cisTechnology || "null"}`
      );
    } else {
      unchanged++;
    }
  }

  const orphans = await db.sCSEMTemplate.findMany({
    where: index.length > 0 ? { id: { notIn: index.map((e) => slugify(e.name)) } } : {},
    select: { id: true, name: true, cisTechnology: true },
  });
  for (const t of orphans) {
    const detected = detect(t.name);
    if (detected && t.cisTechnology !== detected) {
      await db.sCSEMTemplate.update({
        where: { id: t.id },
        data: { cisTechnology: detected },
      });
      updated++;
      console.log(`  ~ (orphan) ${t.name}: ${t.cisTechnology || "null"} -> ${detected}`);
    }
  }

  const total = await db.sCSEMTemplate.count();
  const withTech = await db.sCSEMTemplate.count({ where: { cisTechnology: { not: null } } });
  console.log(
    `CIS tech backfill: created ${created}, updated ${updated}, unchanged ${unchanged}. ` +
      `Totals: ${total} templates, ${withTech} with cisTechnology.`
  );
}

main()
  .catch((error) => {
    console.error("Backfill error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
