import type { EmbeddingProvider } from "../../src/modules/ai/providers/embedding-provider.interface.js";

export class MockLoadTestEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "mock-embedding";
  public readonly dimensions = 768;
  public callCount = 0;

  async generateEmbedding(_text: string): Promise<number[]> {
    this.callCount++;
    const vector = new Array(this.dimensions).fill(0.05);
    // Add deterministic slight variations
    vector[0] = 0.5;
    vector[1] = 0.25;
    return vector;
  }
}
