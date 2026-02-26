import { parseSCSEMFile } from './src/lib/xlsx-parser';

const files = [
  'data/scsems/UNIX-Linux/Safeguards-SCSEM Red Hat Enterprise Linux (RHEL)-v7_02182025.xlsx',
  'data/scsems/Windows/Safeguards-SCSEM Windows Server 2022-v2_0-08122024.xlsx'
];

for (const f of files) {
  try {
    const result = parseSCSEMFile(f);
    console.log(`\n=== ${f} ===`);
    console.log(`Metadata: ${JSON.stringify(result.metadata)}`);
    console.log(`Total controls: ${result.totalControls}`);
    console.log(`Sheets:`);
    for (const s of result.sheets) {
      console.log(`  ${s.sheetIndex}. "${s.sheetName}" [${s.sheetType}] — ${s.controls.length} controls, ${s.changeLogEntries.length} changelog entries, ${s.rawData ? s.rawData.length + ' rows' : 'no raw data'}`);
      if (s.controls.length > 0) {
        console.log(`     First control: ${JSON.stringify(s.controls[0]).substring(0, 200)}`);
      }
      if (s.changeLogEntries.length > 0) {
        console.log(`     First changelog: ${JSON.stringify(s.changeLogEntries[0])}`);
      }
    }
  } catch (e: any) {
    console.error(`Error parsing ${f}: ${e.message}`);
  }
}
