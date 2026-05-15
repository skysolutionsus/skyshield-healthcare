import {
  createBifrostEmbedding,
  getConfiguredBifrostEmbeddingModel,
  hasConfiguredBifrostApiKey,
} from "@/lib/ai/bifrost";

export function getEmbeddingModel(): string {
  return getConfiguredBifrostEmbeddingModel();
}

export function hasEmbeddingConfig(): boolean {
  return hasConfiguredBifrostApiKey(process.env.BIFROST_API_KEY);
}

export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

export async function embedTexts(texts: string[]): Promise<Array<number[] | null>> {
  if (!hasEmbeddingConfig() || texts.length === 0) {
    return texts.map(() => null);
  }

  const data = await createBifrostEmbedding(texts, { model: getEmbeddingModel() });

  const embeddings: Array<number[] | null> = texts.map(() => null);
  for (const item of data.data) {
    embeddings[item.index] = item.embedding;
  }

  return embeddings;
}

export async function embedTextsInBatches(
  texts: string[],
  batchSize = 64
): Promise<Array<number[] | null>> {
  const results: Array<number[] | null> = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    results.push(...(await embedTexts(batch)));
  }

  return results;
}
