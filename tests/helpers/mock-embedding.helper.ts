import type { EmbeddingProvider } from "../../src/modules/ai/providers/embedding-provider.interface.js";

export class TestMockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "test-mock-embedding";
  public readonly dimensions = 768;

  async generateEmbedding(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0.001);
    const lower = text.toLowerCase();

    if (
      lower.includes("code") ||
      lower.includes("typescript") ||
      lower.includes("neovim") ||
      lower.includes("ide") ||
      lower.includes("developer") ||
      lower.includes("billing") ||
      lower.includes("eur") ||
      lower.includes("invoice") ||
      lower.includes("dark mode") ||
      lower.includes("technical") ||
      lower.includes("computation") ||
      lower.includes("backend") ||
      lower.includes("framework") ||
      lower.includes("tech") ||
      lower.includes("stack")
    ) {
      vector[0] = 0.95;
      vector[1] = 0.2;
    } else if (
      lower.includes("cook") ||
      lower.includes("pizza") ||
      lower.includes("recipe") ||
      lower.includes("food")
    ) {
      vector[10] = 0.95;
      vector[11] = 0.2;
    } else if (
      lower.includes("run") ||
      lower.includes("marathon") ||
      lower.includes("fitness") ||
      lower.includes("gym")
    ) {
      vector[20] = 0.95;
      vector[21] = 0.2;
    } else {
      vector[50] = 0.5;
    }

    return vector;
  }
}
