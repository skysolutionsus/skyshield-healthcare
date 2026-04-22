const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export function getEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

export function hasEmbeddingConfig(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

export async function embedTexts(texts: string[]): Promise<Array<number[] | null>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || texts.length === 0) {
    return texts.map(() => null);
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getEmbeddingModel(),
      input: texts,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Embedding request failed: ${response.status} ${detail}`);
  }

  const data = (await response.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
  };

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
