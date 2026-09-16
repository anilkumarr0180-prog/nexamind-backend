export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  generateEmbedding(text: string): Promise<number[]>;
}
