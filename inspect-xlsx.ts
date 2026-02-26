import * as XLSX from 'xlsx';
import * as path from 'path';

// Pick a representative SCSEM file
const files = [
  'data/scsems/Windows/safeguard-microsoft-windows-server-2022-scsem-v20-08122024.xlsx',
  'data/scsems/UNIX-Linux/Safeguards-SCSEM Red Hat Enterprise Linux (RHEL)-v7_02182025.xlsx'
];

for (const file of files) {
  try {
    const wb = XLSX.readFile(file);
    console.log(`\n=== ${path.basename(file)} ===`);
    console.log(`Sheets: ${wb.SheetNames.join(', ')}`);
    
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      const rows = range.e.r - range.s.r + 1;
      const cols = range.e.c - range.s.c + 1;
      console.log(`\n  Sheet: "${sheetName}" (${rows} rows × ${cols} cols)`);
      
      // Show first 5 rows as JSON
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      for (let i = 0; i < Math.min(5, data.length); i++) {
        const row = (data[i] as any[]).slice(0, 10);
        console.log(`    Row ${i}: ${JSON.stringify(row)}`);
      }
    }
  } catch (e: any) {
    console.log(`Error reading ${file}: ${e.message}`);
  }
}
