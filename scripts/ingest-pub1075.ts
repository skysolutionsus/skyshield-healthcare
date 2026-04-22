import { db } from "@/lib/db";
import { hasEmbeddingConfig } from "@/lib/knowledge/embeddings";
import { importKnowledgeDocument, loadLocalPub1075 } from "@/lib/knowledge/ingest";

async function main() {
  console.log("Importing IRS Publication 1075 into the knowledge database...");
  console.log(`Embeddings: ${hasEmbeddingConfig() ? "enabled" : "disabled (keyword search only)"}`);

  const result = await importKnowledgeDocument(loadLocalPub1075());

  console.log("Import complete:");
  console.log(`  documentId: ${result.documentId}`);
  console.log(`  chunks: ${result.chunkCount}`);
  console.log(`  embedded chunks: ${result.embeddedChunkCount}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
