import http from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import app from "../src/app.js";
import { User, type IUser } from "../src/modules/users/user.model.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import { CreditTransaction } from "../src/modules/credit-transactions/credit-transaction.model.js";
import { generateAccessToken } from "../src/utils/jwt.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import { setDefaultEmbeddingProvider } from "../src/modules/attachments/document-embedding.service.js";
import { resetAiRateLimit, resetAuthRateLimit, resetVoiceRateLimit } from "../src/middleware/rate-limit.js";
import { MockLoadTestAIProvider } from "./mocks/mock-ai-provider.js";
import { MockLoadTestEmbeddingProvider } from "./mocks/mock-embedding-provider.js";
import type { LoadTestConfig } from "./config.ts";

export interface TestUserSession {
  user: IUser;
  token: string;
  userId: string;
}

export class LoadTestHarness {
  public baseUrl: string = "";
  private server: http.Server | null = null;
  private isExternalServer = false;
  private originalFetch: typeof globalThis.fetch | null = null;
  public readonly mockAIProvider: MockLoadTestAIProvider;
  public readonly mockEmbeddingProvider: MockLoadTestEmbeddingProvider;

  constructor(public readonly config: LoadTestConfig) {
    this.mockAIProvider = new MockLoadTestAIProvider({
      chunkDelayMs: config.chunkDelayMs,
      toolDelayMs: config.toolDelayMs,
      simulateAgentToolStep: true,
    });
    this.mockEmbeddingProvider = new MockLoadTestEmbeddingProvider();
  }

  public async setup(): Promise<void> {
    // 1. Connect to isolated load-test database
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(this.config.testDbUri);
    }

    // 2. Install Mocks if not in real-provider mode
    if (!this.config.realProviders) {
      orchestratorService.setDefaultProvider(this.mockAIProvider);
      setDefaultEmbeddingProvider(this.mockEmbeddingProvider);

      // Intercept Groq Whisper STT API to avoid burning real voice audio quotas
      this.originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.toString()
            : input.url;

        if (url.includes("api.groq.com/openai/v1/audio/transcriptions")) {
          return new Response(
            JSON.stringify({
              text: "Synthesized transcription received by NexaMind load testing mock.",
              language: "en",
              duration: 3.5,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        return this.originalFetch!(input, init);
      };
    }

    // 3. Configure HTTP target (in-process ephemeral server or external staging URL)
    if (this.config.targetUrl) {
      this.isExternalServer = true;
      this.baseUrl = this.config.targetUrl.replace(/\/+$/, "");
    } else {
      this.server = http.createServer(app);
      await new Promise<void>((resolve) => this.server!.listen(0, resolve));
      const { port } = this.server.address() as AddressInfo;
      this.baseUrl = `http://127.0.0.1:${port}`;
    }
  }

  public async createTestUser(
    prefix: string = "loadtest",
    initialCredits: number = 500
  ): Promise<TestUserSession> {
    const timestamp = Date.now();
    const randomSuffix = Math.floor(Math.random() * 100000);
    const user = await User.create({
      name: `${prefix} Test User`,
      email: `${prefix}-${timestamp}-${randomSuffix}@loadtest.local`,
      passwordHash: "loadtestSecureHash1234567890",
      roles: ["USER"],
      status: "ACTIVE",
    });

    const userId = user._id.toString();
    await tokenService.initializeBalance(userId, initialCredits);

    const token = generateAccessToken({
      sub: userId,
      email: user.email,
      roles: ["USER"],
    });

    return { user, token, userId };
  }

  public async createTestConversation(
    userId: string,
    title: string = "Load Test Conversation"
  ) {
    return Conversation.create({
      userId: new mongoose.Types.ObjectId(userId),
      title,
      status: "ACTIVE",
    });
  }

  public async resetRateLimits(): Promise<void> {
    await resetAiRateLimit();
    await resetAuthRateLimit();
    await resetVoiceRateLimit();
  }

  public async cleanUpUser(userId: string): Promise<void> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      await Promise.all([
        User.deleteOne({ _id: userObjectId }),
        Conversation.deleteMany({ userId: userObjectId }),
        Message.deleteMany({ userId: userObjectId }),
        TokenBalance.deleteMany({ userId: userObjectId }),
        CreditTransaction.deleteMany({ userId: userObjectId }),
      ]);
    } catch {
      // Non-fatal cleanup
    }
  }

  public async teardown(): Promise<void> {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}
