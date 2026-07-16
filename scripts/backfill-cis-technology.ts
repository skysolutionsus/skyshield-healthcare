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

// Embedded fallback — mirrors data/scsem-index.json. Used when the JSON
// file is not reachable at runtime (e.g. volume mount shadowing /app/data
// in the production container).
const EMBEDDED_INDEX: IndexEntry[] = [
  { name: "DB2_LUW_zOS v12 093023", category: "Database", file: "data/scsems/Database/Safeguards-SCSEM DB2_LUW_zOS-v12-093023.xlsx" },
  { name: "MongoDB v25 093023", category: "Database", file: "data/scsems/Database/Safeguards-SCSEM MongoDB-v25-093023.xlsx" },
  { name: "MySQL v24 093023", category: "Database", file: "data/scsems/Database/Safeguards-SCSEM MySQL-v24-093023.xlsx" },
  { name: "SQL Server v6_0 08252024", category: "Database", file: "data/scsems/Database/Safeguards-SCSEM SQL-Server-v6_0-08252024.xlsx" },
  { name: "data_warehouse v28 093023", category: "Database", file: "data/scsems/Database/Safeguards-SCSEM data_warehouse-v28-093023.xlsx" },
  { name: "generic db v29 093023", category: "Database", file: "data/scsems/Database/Safeguards-SCSEM generic-db-v29-093023.xlsx" },
  { name: "oracle v44 093023", category: "Database", file: "data/scsems/Database/Safeguards-SCSEM oracle-v44-093023.xlsx" },
  { name: "sql server v50 093023", category: "Database", file: "data/scsems/Database/Safeguards-SCSEM sql-server-v50-093023.xlsx" },
  { name: "MacOSX 80 093023", category: "MacOS", file: "data/scsems/MacOS/Safeguards-SCSEM MacOSX-80-093023.xlsx" },
  { name: "Apache24_IIS 10 WebServer SCSEM v6_0_06162025", category: "Web", file: "data/scsems/Web/Safeguards-SCSEM Apache24_IIS-10-WebServer-SCSEM-v6_0_06162025.xlsx" },
  { name: "NGINX WebServer v10 093023", category: "Web", file: "data/scsems/Web/Safeguards-SCSEM NGINX-WebServer-v10-093023.xlsx" },
  { name: "generic web server v29 093023", category: "Web", file: "data/scsems/Web/Safeguards-SCSEM generic-web-server-v29-093023.xlsx" },
  { name: "Check Point Firewall v1_0 02202025", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM Check-Point Firewall-v1_0-02202025.xlsx" },
  { name: "Cisco ASA Firewall v1_1 02202025", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM Cisco-ASA-Firewall-v1_1-02202025.xlsx" },
  { name: "Generic Firewall v7_0 02202025", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM Generic-Firewall-v7_0-02202025.xlsx" },
  { name: "Palo Alto Firewall V1_0   10082024", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM Palo Alto Firewall-V1_0 - 10082024.xlsx" },
  { name: "Switch_Router v62 093023", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM Switch_Router-v62-093023.xlsx" },
  { name: "network assessment v34 093023", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM network-assessment-v34-093023.xlsx" },
  { name: "san v33 093023", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM san-v33-093023.xlsx" },
  { name: "voip network v29 093023", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM voip-network-v29-093023.xlsx" },
  { name: "vpn v29 0930253", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM vpn-v29-0930253.xlsx" },
  { name: "wireless networking v29 093023", category: "Network", file: "data/scsems/Network/Safeguards-SCSEM wireless-networking-v29-093023.xlsx" },
  { name: "safeguards scsem fortigate v10 120124", category: "Network", file: "data/scsems/Network/safeguards-scsem-fortigate-v10-120124.xlsx" },
  { name: "safeguards scsem mot v50 12312024", category: "MOT", file: "data/scsems/MOT/safeguards-scsem-mot-v50-12312024.xlsx" },
  { name: "AIX7 v3_0_0   03312025", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM AIX7-v3_0_0 - 03312025.xlsx" },
  { name: "Debian v20 093023", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM Debian-v20-093023.xlsx" },
  { name: "Generic unix linux v115 093023", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM Generic-unix-linux-v115-093023.xlsx" },
  { name: "HPUX11i v18 093023", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM HPUX11i-v18-093023.xlsx" },
  { name: "OEL v5_0_0   03312025", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM OEL-v5_0_0 - 03312025.xlsx" },
  { name: "Oracle Solaris v4_0_0   05222025", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM Oracle-Solaris-v4_0_0 - 05222025.xlsx" },
  { name: "Oracle_Solaris v34 093023", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM Oracle_Solaris-v34-093023.xlsx" },
  { name: "Amazon Linux 2023 v1_0", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM Amazon Linux 2023-v1_0.xlsx" },
  { name: "Red Hat Enterprise Linux (RHEL) v7_02182025", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM Red Hat Enterprise Linux (RHEL)-v7_02182025.xlsx" },
  { name: "Rocky v10 093023", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM Rocky-v10-093023.xlsx" },
  { name: "SUSE Linux v5_0_0   03312025", category: "UNIX-Linux", file: "data/scsems/UNIX-Linux/Safeguards-SCSEM SUSE-Linux-v5_0_0 - 03312025.xlsx" },
  { name: "Apple iOS iPadOS v1_0 02212025", category: "Others", file: "data/scsems/Others/Safeguards-SCSEM Apple-iOS-iPadOS-v1_0-02212025.xlsx" },
  { name: "Cloud v7_0 11152024", category: "Others", file: "data/scsems/Others/Safeguards-SCSEM Cloud-v7_0-11152024.xlsx" },
  { name: "generic os v29 093023", category: "Others", file: "data/scsems/Others/Safeguards-SCSEM generic-os-v29-093023.xlsx" },
  { name: "printer v44 093023", category: "Others", file: "data/scsems/Others/Safeguards-SCSEM printer-v44-093023.xlsx" },
  { name: "Generic_VDI v18 093023", category: "Virtulization", file: "data/scsems/Virtulization/Safeguards-SCSEM Generic_VDI-v18-093023.xlsx" },
  { name: "VMWare ESXi v5_0 0918024", category: "Virtulization", file: "data/scsems/Virtulization/Safeguards-SCSEM VMWare-ESXi-v5_0-0918024.xlsx" },
  { name: "Containers v2  06262025", category: "Containers", file: "data/scsems/Containers/Safeguards-SCSEM Containers-v2--06262025.xlsx" },
  { name: "Apache_Tomcat v30 093023", category: "Application", file: "data/scsems/Application/Safeguards-SCSEM Apache_Tomcat-v30-093023.xlsx" },
  { name: "Application v4_0_0   03312025", category: "Application", file: "data/scsems/Application/Safeguards-SCSEM Application-v4_0_0 - 03312025.xlsx" },
  { name: "etpm v28 093023", category: "Application", file: "data/scsems/Application/Safeguards-SCSEM etpm-v28-093023.xlsx" },
  { name: "gentax v44 093023", category: "Application", file: "data/scsems/Application/Safeguards-SCSEM gentax-v44-093023.xlsx" },
  { name: "rsi revenue premier v37 093023", category: "Application", file: "data/scsems/Application/Safeguards-SCSEM rsi-revenue-premier-v37-093023.xlsx" },
  { name: "teradata v37 093023", category: "Application", file: "data/scsems/Application/Safeguards-SCSEM teradata-v37-093023.xlsx" },
  { name: "ACF2 v38 093023", category: "Mainframe", file: "data/scsems/Mainframe/Safeguards-SCSEM ACF2-v38-093023.xlsx" },
  { name: "IBMi OS v15 093023", category: "Mainframe", file: "data/scsems/Mainframe/Safeguards-SCSEM IBMi-OS-v15-093023.xlsx" },
  { name: "racf v35 093023", category: "Mainframe", file: "data/scsems/Mainframe/Safeguards-SCSEM racf-v35-093023.xlsx" },
  { name: "top secret v35 093023", category: "Mainframe", file: "data/scsems/Mainframe/Safeguards-SCSEM top-secret-v35-093023.xlsx" },
  { name: "unisys v38 093023", category: "Mainframe", file: "data/scsems/Mainframe/Safeguards-SCSEM unisys-v38-093023.xlsx" },
  { name: "Windows 10 v6_0 08122024", category: "Windows", file: "data/scsems/Windows/Safeguards-SCSEM Windows 10-v6_0-08122024.xlsx" },
  { name: "Windows 11 v3_0_1 03312025", category: "Windows", file: "data/scsems/Windows/Safeguards-SCSEM Windows 11-v3_0_1-03312025.xlsx" },
  { name: "Windows Server 2012R2 v36 093023", category: "Windows", file: "data/scsems/Windows/Safeguards-SCSEM Windows Server 2012R2-v36-093023.xlsx" },
  { name: "Windows Server 2016 v3_0 08122024", category: "Windows", file: "data/scsems/Windows/Safeguards-SCSEM Windows Server 2016-v3_0-08122024.xlsx" },
  { name: "Windows Server 2019 v2.0 07142024", category: "Windows", file: "data/scsems/Windows/Safeguards-SCSEM Windows Server 2019-v2.0-07142024.xlsx" },
  { name: "Windows Server 2022 v2_0 08122024", category: "Windows", file: "data/scsems/Windows/Safeguards-SCSEM Windows Server 2022-v2_0-08122024.xlsx" },
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
  console.log(
    `  SCSEM index JSON not reachable (checked ${candidates.join(", ")}). ` +
      `Using embedded index (${EMBEDDED_INDEX.length} templates).`
  );
  return EMBEDDED_INDEX;
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
    where: { id: { notIn: index.map((e) => slugify(e.name)) } },
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
