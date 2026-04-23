import { db } from "@/lib/db";

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

async function main() {
  const templates = await db.sCSEMTemplate.findMany({
    select: { id: true, name: true, cisTechnology: true },
  });

  let updated = 0;
  let unchanged = 0;
  let unmatched = 0;

  for (const t of templates) {
    const detected = detect(t.name);
    if (!detected) {
      unmatched++;
      continue;
    }
    if (t.cisTechnology === detected) {
      unchanged++;
      continue;
    }
    await db.sCSEMTemplate.update({
      where: { id: t.id },
      data: { cisTechnology: detected },
    });
    updated++;
    console.log(`  ${t.name} -> ${detected}`);
  }

  console.log(
    `CIS tech backfill: updated ${updated}, unchanged ${unchanged}, no-match ${unmatched} (of ${templates.length})`
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
