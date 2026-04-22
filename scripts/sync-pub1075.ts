import { db } from "@/lib/db";
import { hasEmbeddingConfig } from "@/lib/knowledge/embeddings";
import {
  importKnowledgeDocument,
  loadOfficialPub1075FromIrs,
} from "@/lib/knowledge/ingest";

async function main() {
  console.log("Downloading official IRS Publication 1075 PDF from IRS.gov...");
  console.log(`Embeddings: ${hasEmbeddingConfig() ? "enabled" : "disabled (keyword search only)"}`);

  const pub1075 = await loadOfficialPub1075FromIrs();
  console.log(`Downloaded ${pub1075.pdfSizeKB}KB PDF with ${pub1075.pageCount} pages`);

  const result = await importKnowledgeDocument(pub1075);

  console.log("Sync complete:");
  console.log(`  documentId: ${result.documentId}`);
  console.log(`  version: ${pub1075.version}`);
  console.log(`  chunks: ${result.chunkCount}`);
  console.log(`  embedded chunks: ${result.embeddedChunkCount}`);
  console.log(`  pdfSha256: ${pub1075.pdfSha256}`);
  console.log(`  textSha256: ${pub1075.textSha256}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
