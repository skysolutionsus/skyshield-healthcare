import * as XLSX from 'xlsx';

const wb = XLSX.readFile('data/scsems/UNIX-Linux/Safeguards-SCSEM Red Hat Enterprise Linux (RHEL)-v7_02182025.xlsx');
const ws = wb.Sheets['Change Log'];
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
console.log("Change Log sheet (first 15 rows):");
for (let i = 0; i < Math.min(15, data.length); i++) {
  const row = (data[i] as any[]).slice(0, 6);
  console.log(`  Row ${i}: ${JSON.stringify(row)}`);
}
