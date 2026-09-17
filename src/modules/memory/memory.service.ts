import { env } from "../../config/env.js";
import { AppError } from "../../errors/app.error.js";
import {
  MEMORY_TYPES,
  type IMemory,
  type MemoryType,
} from "./memory.model.js";
import * as memoryRepository from "./memory.repository.js";
import type {
  FindActiveMemoriesOptions,
  UpdateMemoryData,
} from "./memory.repository.js";
import { memoryExtractionResponseSchema } from "./memory.validation.js";
import type {
  AIProvider,
  AIMessage,
} from "../ai/providers/ai-provider.interface.js";
import type { EmbeddingProvider } from "../ai/providers/embedding-provider.interface.js";
import { OllamaEmbeddingProvider } from "../ai/providers/ollama-embedding.provider.js";

let defaultEmbeddingProvider: EmbeddingProvider = new OllamaEmbeddingProvider();

export const setDefaultEmbeddingProvider = (
  provider: EmbeddingProvider,
): void => {
  defaultEmbeddingProvider = provider;
};

export const getDefaultEmbeddingProvider = (): EmbeddingProvider => {
  return defaultEmbeddingProvider;
};

export const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system for NexaMind AI.
Analyze the conversation turn and extract ONLY durable, long-term user information that will be useful across future conversations.

Allowed memory types:
- FACT: Persistent factual information about the user (e.g., profession, current project, tech stack).
- PREFERENCE: User preferences (e.g., communication style, concise vs detailed, preferred languages/tools).
- GOAL: User goals or objectives (e.g., aims to learn system design, planning to build an application).
- INSTRUCTION: Persistent directives for the assistant (e.g., always write production-ready TypeScript code).

Rules:
1. Extract ONLY facts/preferences/goals/instructions about the USER. Do not extract assistant facts or general knowledge.
2. Do NOT extract temporary details, conversational filler, one-off questions, or transient state.
3. Do NOT extract secrets, passwords, tokens, API keys, credentials, or personal sensitive data.
4. Output MUST be valid JSON conforming to this schema:
{
  "memories": [
    {
      "type": "FACT" | "PREFERENCE" | "GOAL" | "INSTRUCTION",
      "content": "concise description of the memory"
    }
  ]
}
If no durable information is worth remembering, return:
{"memories": []}
Output ONLY the JSON object. Do not include markdown code fences, thought processes, or explanatory text.`;

export const isSafeMemoryContent = (content: string): boolean => {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  // 1. JWT Tokens
  if (/\bey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+\b/.test(trimmed)) {
    return false;
  }

  // 2. Common API Keys (OpenAI, GitHub, AWS, Slack, generic)
  if (/\b(?:sk-[a-zA-Z0-9]{20,}|gh[po]_[a-zA-Z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-zA-Z0-9-]{10,})\b/.test(trimmed)) {
    return false;
  }

  // 3. Private Keys
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(trimmed)) {
    return false;
  }

  // 4. Password and Secret declarations
  if (/(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*\S+/i.test(trimmed)) {
    return false;
  }

  // 5. Bearer tokens
  if (/\bbearer\s+[A-Za-z0-9._~+/-]+=*\b/i.test(trimmed)) {
    return false;
  }

  // 6. Prompt injection / Developer mode instructions
  if (/(?:\bignore\s+(?:all\s+)?previous\s+instructions|\byou\s+are\s+now\s+in\s+developer\s+mode|\bsystem\s+prompt\s*:)/i.test(trimmed)) {
    return false;
  }

  return true;
};

export type MemoryExtractionInput = {
  userMessageContent: string;
  assistantMessageContent?: string | undefined;
};

export type ExtractedMemoryResult = {
  success: boolean;
  extractedCount: number;
  memories: IMemory[];
};

export const extractAndSaveMemories = async (
  userId: string,
  input: MemoryExtractionInput,
  provider: AIProvider,
): Promise<ExtractedMemoryResult> => {
  try {
    const userPrompt = `User Message: ${input.userMessageContent.slice(0, 2000)}${
      input.assistantMessageContent
        ? `\n\nAssistant Response: ${input.assistantMessageContent.slice(0, 2000)}`
        : ""
    }`;

    const extractionMessages: AIMessage[] = [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    const response = await provider.generateChatResponse(extractionMessages, { maxTokens: 400 });

    // Clean potential markdown fences e.g. ```json ... ```
    let cleanContent = response.content.trim();
    if (cleanContent.startsWith("```")) {
      cleanContent = cleanContent
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(cleanContent);
    } catch {
      console.warn("Memory extraction: Model output was not valid JSON");
      return { success: false, extractedCount: 0, memories: [] };
    }

    const validationResult =
      memoryExtractionResponseSchema.safeParse(parsedJson);
    if (!validationResult.success) {
      console.warn(
        "Memory extraction: Model JSON failed schema validation:",
        validationResult.error.issues,
      );
      return { success: false, extractedCount: 0, memories: [] };
    }

    // Limit candidates by AI_MAX_EXTRACTED_MEMORIES_PER_CHAT
    const candidates = validationResult.data.memories.slice(
      0,
      env.AI_MAX_EXTRACTED_MEMORIES_PER_CHAT,
    );

    if (candidates.length === 0) {
      return { success: true, extractedCount: 0, memories: [] };
    }

    // Fetch user's existing active memories for deduplication
    const existingMemories =
      await memoryRepository.findActiveMemoriesByUserId(userId);

    const savedMemories: IMemory[] = [];
    const seenBatchContent = new Set<string>();

    for (const candidate of candidates) {
      const trimmedContent = candidate.content.trim();

      // 1. Backend Security & Secret Filter
      if (!isSafeMemoryContent(trimmedContent)) {
        console.warn(
          `Memory extraction: candidate rejected by safety filter: "${trimmedContent.slice(0, 30)}..."`,
        );
        continue;
      }

      // 2. Intra-batch deduplication
      const batchKey = `${candidate.type}:${trimmedContent.toLowerCase()}`;
      if (seenBatchContent.has(batchKey)) {
        continue;
      }
      seenBatchContent.add(batchKey);

      // 3. Duplicate check against existing active memories of THIS user
      const isDuplicate = existingMemories.some(
        (existing) =>
          existing.type === candidate.type &&
          existing.content.trim().toLowerCase() ===
            trimmedContent.toLowerCase(),
      );

      if (isDuplicate) {
        continue;
      }

      let embedding: number[] | undefined;
      try {
        embedding = await defaultEmbeddingProvider.generateEmbedding(trimmedContent);
      } catch (embErr) {
        // Non-fatal: proceed without embedding
      }

      // 4. Save new active memory
      const created = await memoryRepository.createMemory({
        userId,
        type: candidate.type,
        content: trimmedContent,
        embedding,
      });

      savedMemories.push(created);
    }

    return {
      success: true,
      extractedCount: savedMemories.length,
      memories: savedMemories,
    };
  } catch (error) {
    console.error("Non-fatal error during memory extraction:", error);
    return { success: false, extractedCount: 0, memories: [] };
  }
};

export type CreateMemoryInput = {
  type: MemoryType;
  content: string;
};

export type UpdateMemoryInput = {
  type?: MemoryType | undefined;
  content?: string | undefined;
};

export const getActiveMemoryContextForUser = async (
  userId: string,
  limit: number = env.AI_MAX_MEMORY_CONTEXT,
): Promise<string | null> => {
  const boundedLimit = Math.max(1, limit);
  const memories = await memoryRepository.findActiveMemoriesByUserId(userId, {
    limit: boundedLimit,
  });

  if (memories.length === 0) {
    return null;
  }

  const memoryLines = memories.map(
    (mem) => `- [${mem.type}] ${mem.content.trim()}`,
  );

  return `Relevant user memories:\n${memoryLines.join("\n")}`;
};

export const getSemanticMemoryContextForUser = async (
  userId: string,
  query?: string | null,
  limit: number = env.AI_MAX_MEMORY_CONTEXT,
): Promise<string | null> => {
  const boundedLimit = Math.max(1, limit);

  if (!env.AI_MEMORY_SEMANTIC_SEARCH_ENABLED || !query || !query.trim()) {
    return getActiveMemoryContextForUser(userId, boundedLimit);
  }

  try {
    const queryVector = await defaultEmbeddingProvider.generateEmbedding(
      query.trim(),
    );

    const results = await memoryRepository.searchActiveMemoriesByVector(
      userId,
      queryVector,
      { limit: boundedLimit },
    );

    if (results.length > 0) {
      const memoryLines = results.map(
        (mem) => `- [${mem.type}] ${mem.content.trim()}`,
      );
      return `Relevant user memories:\n${memoryLines.join("\n")}`;
    }

    // Fall back gracefully to recency if semantic results are empty (e.g. legacy memories)
    return getActiveMemoryContextForUser(userId, boundedLimit);
  } catch (error) {
    console.warn(
      "Non-fatal error during semantic memory retrieval, falling back to recency:",
      error,
    );
    return getActiveMemoryContextForUser(userId, boundedLimit);
  }
};

export const createMemory = async (
  userId: string,
  data: CreateMemoryInput,
) => {
  if (!data.type || !Object.values(MEMORY_TYPES).includes(data.type)) {
    throw new AppError("Invalid memory type", 400, "INVALID_TYPE");
  }

  const trimmedContent = data.content?.trim();
  if (!trimmedContent) {
    throw new AppError("Memory content is required", 400, "INVALID_INPUT");
  }

  if (trimmedContent.length > 2000) {
    throw new AppError(
      "Memory content cannot exceed 2000 characters",
      400,
      "INVALID_INPUT",
    );
  }

  let embedding: number[] | undefined;
  try {
    embedding = await defaultEmbeddingProvider.generateEmbedding(trimmedContent);
  } catch (embErr) {
    // Non-fatal: proceed without embedding
  }

  return memoryRepository.createMemory({
    userId,
    type: data.type,
    content: trimmedContent,
    embedding,
  });
};

export const getMemoryById = async (
  memoryId: string,
  userId: string,
) => {
  const memory = await memoryRepository.findMemoryByIdAndUserId(
    memoryId,
    userId,
  );

  if (!memory) {
    throw new AppError("Memory not found", 404, "MEMORY_NOT_FOUND");
  }

  return memory;
};

export const getUserMemories = async (
  userId: string,
  options?: FindActiveMemoriesOptions,
) => {
  if (options?.type && !Object.values(MEMORY_TYPES).includes(options.type)) {
    throw new AppError("Invalid memory type", 400, "INVALID_TYPE");
  }

  return memoryRepository.findActiveMemoriesByUserId(userId, options);
};

export const updateMemory = async (
  memoryId: string,
  userId: string,
  data: UpdateMemoryInput,
) => {
  const updateData: UpdateMemoryData = {};

  if (data.type !== undefined) {
    if (!Object.values(MEMORY_TYPES).includes(data.type)) {
      throw new AppError("Invalid memory type", 400, "INVALID_TYPE");
    }
    updateData.type = data.type;
  }

  if (data.content !== undefined) {
    const trimmedContent = data.content.trim();
    if (!trimmedContent) {
      throw new AppError(
        "Memory content cannot be empty",
        400,
        "INVALID_INPUT",
      );
    }
    if (trimmedContent.length > 2000) {
      throw new AppError(
        "Memory content cannot exceed 2000 characters",
        400,
        "INVALID_INPUT",
      );
    }
    updateData.content = trimmedContent;
  }

  const updatedMemory = await memoryRepository.updateMemory(
    memoryId,
    userId,
    updateData,
  );

  if (!updatedMemory) {
    throw new AppError("Memory not found", 404, "MEMORY_NOT_FOUND");
  }

  return updatedMemory;
};

export const deleteMemory = async (
  memoryId: string,
  userId: string,
) => {
  const deletedMemory = await memoryRepository.softDeleteMemory(
    memoryId,
    userId,
  );

  if (!deletedMemory) {
    throw new AppError("Memory not found", 404, "MEMORY_NOT_FOUND");
  }

  return deletedMemory;
};
