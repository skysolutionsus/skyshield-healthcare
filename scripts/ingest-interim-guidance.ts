import { readFileSync } from "fs";
import { join } from "path";
import {
  inferInterimGuidanceInput,
  INTERIM_GUIDANCE_SOURCE_TYPE,
} from "@/lib/knowledge/interim-guidance";
import { importKnowledgeDocument } from "@/lib/knowledge/ingest";
import { db } from "@/lib/db";

const DEFAULT_FILES = [
  "Publication 1075 Interim Guidance - Authentication.txt",
  "Publication 1075 Interim Guidance - Data Incidents.txt",
  "Publication 1075 Interim Guidance - Disallowing Triple Data Encryption Algorithm (TDEA) and Triple Data Encryption Standard (3DES) for federal.txt",
];

async function main() {
  const fileNames = process.argv.slice(2);
  const files = fileNames.length > 0 ? fileNames : DEFAULT_FILES;

  for (const fileName of files) {
    const filePath = join(process.cwd(), "public", fileName);
    const text = readFileSync(filePath, "utf-8");
    const input = inferInterimGuidanceInput({
      fileName,
      text,
      sourceName: fileName,
      metadata: {
        bundledExample: true,
        sourcePath: `public/${fileName}`,
        sourceType: INTERIM_GUIDANCE_SOURCE_TYPE,
      },
    });

    const result = await importKnowledgeDocument(input);
    console.log(
      `Imported ${input.title}: ${result.chunkCount} chunks, ${result.embeddedChunkCount} embedded`
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
