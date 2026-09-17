import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation, CONVERSATION_STATUSES } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { Memory, MEMORY_TYPES, MEMORY_STATUSES } from "../src/modules/memory/memory.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as conversationService from "../src/modules/conversations/conversation.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import {
  AgentService,
  setAgentService,
  AGENT_STATUSES,
  ToolRegistry,
  calculatorTool,
} from "../src/modules/agent/index.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

class MockAgentContextAIProvider implements AIProvider {
  public readonly name = "mock-agent-context-ai";
  public calls: Array<{ messages: AIMessage[]; options?: ChatResponseOptions }> = [];
  public forceCalculatorToolCall = false;

  async generateChatResponse(
    messages: AIMessage[],
    options?: ChatResponseOptions,
  ): Promise<AIResponse> {
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)), options });

    const isExtraction = messages.some(
      (m) => m.role === "system" && m.content.includes("memory extraction system"),
    );
    if (isExtraction) {
      return {
        content: JSON.stringify({ memories: [] }),
        provider: "mock-agent-context-ai",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    }

    // Check if previous turn had tool output
    const lastToolMsg = messages.find((m) => m.role === "tool");
    if (lastToolMsg) {
      return {
        content: `Calculation complete: Result is ${lastToolMsg.content}`,
        provider: "mock-agent-context-ai",
        model: "mock-model",
        usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      };
    }

    if (this.forceCalculatorToolCall) {
      this.forceCalculatorToolCall = false; // execute once
      return {
        content: "Calculating the total amount...",
        provider: "mock-agent-context-ai",
        model: "mock-model",
        toolCalls: [
          {
            id: "call_calc_123",
            name: "calculator",
            arguments: { expression: "3 * 120" },
          },
        ],
        usage: { inputTokens: 25, outputTokens: 15, totalTokens: 40 },
      };
    }

    return {
      content: "Agent successfully processed task with shared context.",
      provider: "mock-agent-context-ai",
      model: "mock-model",
      usage: { inputTokens: 35, outputTokens: 25, totalTokens: 60 },
    };
  }

  async *generateChatStream(
    messages: AIMessage[],
    _options?: ChatResponseOptions,
    _signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)) });

    yield {
      content: "Streaming agent test chunk",
      model: "mock-model",
    };

    yield {
      content: "",
      model: "mock-model",
      usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
      done: true,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Batch 5: Agent + Shared Context Builder Test Suite ===");
  await connectDatabase();

  const mockProvider = new MockAgentContextAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const registry = new ToolRegistry();
  registry.register(calculatorTool);
  const testAgentService = new AgentService({
    provider: mockProvider,
    registry,
  });
  setAgentService(testAgentService);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server active at ${baseUrl}`);

  const testTimestamp = Date.now();
  const userAEmail = `agent_ctx_a_${testTimestamp}@example.com`;
  const userBEmail = `agent_ctx_b_${testTimestamp}@example.com`;
  const testPassword = "Password123!@#$";

  let userAId = "";
  let userBId = "";
  let userAToken = "";
  let userBToken = "";
  let userAConvId = "";

  try {
    // 1. Setup authenticated users
    const regA = await authService.register({ email: userAEmail, password: testPassword });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password: testPassword });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    await tokenService.refundCredits(userAId, 50);
    await tokenService.refundCredits(userBId, 50);

    // 2. Setup User A Conversation with history and summary
    const conv = await conversationService.createConversation(userAId, {
      title: "Invoice & Billing Microservice Project",
    });
    userAConvId = conv._id.toString();

    await Message.create({
      conversationId: userAConvId,
      userId: userAId,
      role: MESSAGE_ROLES.USER,
      content: "Let us design the invoice billing service architecture.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    await Message.create({
      conversationId: userAConvId,
      userId: userAId,
      role: MESSAGE_ROLES.ASSISTANT,
      content: "We chose Stripe webhook integration and PostgreSQL ledger tables.",
      status: MESSAGE_STATUSES.COMPLETED,
    });

    // Set conversation summary on document
    await Conversation.findByIdAndUpdate(userAConvId, {
      messageCount: 2,
      lastMessageAt: new Date(),
      summary: "- Designed Stripe webhook processing and idempotent ledger.\n- Left off at calculating subscription pricing tiers.",
      summaryUpdatedAt: new Date(),
      lastSummarizedMessageCount: 2,
    });

    // Setup User A Long-term Memory
    await Memory.create({
      userId: userAId,
      type: MEMORY_TYPES.PREFERENCE,
      content: "User prefers currency in EUR and strict 2-decimal formatting",
      status: MEMORY_STATUSES.ACTIVE,
    });

    // -------------------------------------------------------------
    // Test 1: Agent Receives Conversation Context & Summary
    // -------------------------------------------------------------
    console.log("\n[Test 1] Testing Agent receives previous conversation messages and summary...");
    mockProvider.calls = [];

    const res1 = await fetch(`${baseUrl}/api/v1/agent/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: userAConvId,
        task: "What billing architecture decisions did we make so far?",
      }),
    });

    assert.equal(res1.status, 200);
    const json1 = (await res1.json()) as any;
    assert.equal(json1.success, true);
    assert.equal(json1.data.status, AGENT_STATUSES.COMPLETED);

    // Verify messages delivered to provider
    const firstCall = mockProvider.calls[0]!;
    const allPromptContents = firstCall.messages.map((m) => m.content).join("\n\n");

    assert.ok(
      allPromptContents.includes("Invoice & Billing Microservice Project") ||
      allPromptContents.includes("Stripe webhook processing") ||
      allPromptContents.includes("Conversation summary:"),
      "Agent must receive Conversation summary from Context Builder",
    );
    assert.ok(
      allPromptContents.includes("Relevant user memories:"),
      "Agent must receive User Memories from Context Builder",
    );
    assert.ok(
      allPromptContents.includes("EUR and strict 2-decimal formatting"),
      "Agent prompt must contain specific memory content",
    );
    assert.ok(
      allPromptContents.includes("What billing architecture decisions did we make so far?"),
      "Agent prompt must contain the current task",
    );
    console.log("✓ Test 1 Passed: Agent successfully received unified context (summary, memories, messages)");

    // -------------------------------------------------------------
    // Test 2: Agent Conversation Message Persistence
    // -------------------------------------------------------------
    console.log("\n[Test 2] Testing agent user task and assistant response persistence in MongoDB...");
    const messagesInDb = await Message.find({ conversationId: userAConvId }).sort({ createdAt: 1 });
    // Initially had 2 messages; Test 1 added 1 user message + 1 assistant message = total 4
    assert.equal(messagesInDb.length, 4, "Conversation must have 4 messages after agent run");

    const latestUserMsg = messagesInDb[2]!;
    assert.equal(latestUserMsg.role, MESSAGE_ROLES.USER);
    assert.equal(latestUserMsg.content, "What billing architecture decisions did we make so far?");

    const latestAssistantMsg = messagesInDb[3]!;
    assert.equal(latestAssistantMsg.role, MESSAGE_ROLES.ASSISTANT);
    assert.equal(latestAssistantMsg.content, json1.data.output);
    assert.ok(latestAssistantMsg.usage, "Token usage must be persisted on assistant message");

    const convAfterRun = await Conversation.findById(userAConvId);
    assert.equal(convAfterRun?.messageCount, 4);
    console.log("✓ Test 2 Passed: User task and Agent response persisted correctly to MongoDB messages");

    // -------------------------------------------------------------
    // Test 3: Agent Tool Execution within Shared Context
    // -------------------------------------------------------------
    console.log("\n[Test 3] Testing agent tool execution (calculator) within shared context...");
    mockProvider.calls = [];
    mockProvider.forceCalculatorToolCall = true;

    const res3 = await fetch(`${baseUrl}/api/v1/agent/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: userAConvId,
        task: "Calculate 3 annual tiers at 120 per tier",
      }),
    });

    assert.equal(res3.status, 200);
    const json3 = (await res3.json()) as any;
    assert.equal(json3.success, true);
    assert.equal(json3.data.status, AGENT_STATUSES.COMPLETED);
    assert.ok(json3.data.output.includes("Result is 360") || json3.data.output.includes("360"));
    assert.equal(json3.data.toolCalls.length, 1);
    assert.equal(json3.data.toolCalls[0].name, "calculator");
    assert.equal(json3.data.toolCalls[0].status, "SUCCESS");
    console.log("✓ Test 3 Passed: Calculator tool executed cleanly in agent loop with shared context");

    // -------------------------------------------------------------
    // Test 4: Cross-User Isolation Enforcement
    // -------------------------------------------------------------
    console.log("\n[Test 4] Testing cross-user isolation: User B cannot run agent in User A's conversation...");
    const res4 = await fetch(`${baseUrl}/api/v1/agent/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        conversationId: userAConvId,
        task: "Infiltrate User A billing data",
      }),
    });

    assert.equal(res4.status, 404, "Cross-user conversation access must be rejected with 404");
    const json4 = (await res4.json()) as any;
    assert.equal(json4.error.code, "CONVERSATION_NOT_FOUND");
    console.log("✓ Test 4 Passed: Strict cross-user isolation enforced; returned 404 CONVERSATION_NOT_FOUND");

    // -------------------------------------------------------------
    // Test 5: Archived Conversation Rejection
    // -------------------------------------------------------------
    console.log("\n[Test 5] Testing archived conversation rejection...");
    const archivedConv = await conversationService.createConversation(userAId, {
      title: "Archived Project",
    });
    await conversationService.archiveConversation(archivedConv._id.toString(), userAId);

    const res5 = await fetch(`${baseUrl}/api/v1/agent/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: archivedConv._id.toString(),
        task: "Work on archived project",
      }),
    });

    assert.equal(res5.status, 400, "Archived conversation must return 400");
    const json5 = (await res5.json()) as any;
    assert.equal(json5.error.code, "CONVERSATION_ARCHIVED");
    console.log("✓ Test 5 Passed: Archived conversation rejected with 400 CONVERSATION_ARCHIVED");

    // -------------------------------------------------------------
    // Test 6: Standalone Agent Run (without conversationId)
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing standalone agent execution without conversationId...");
    mockProvider.calls = [];

    const res6 = await fetch(`${baseUrl}/api/v1/agent/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        task: "Standalone computation task",
      }),
    });

    assert.equal(res6.status, 200);
    const json6 = (await res6.json()) as any;
    assert.equal(json6.success, true);
    assert.equal(json6.data.status, AGENT_STATUSES.COMPLETED);

    // Should include user memories even without conversation
    const prompt6 = mockProvider.calls[0]!.messages.map((m) => m.content).join("\n\n");
    assert.ok(
      prompt6.includes("Relevant user memories:") && prompt6.includes("EUR"),
      "Standalone agent task must still receive user long-term memories",
    );
    console.log("✓ Test 6 Passed: Standalone agent run executed and received user memory context");

    // -------------------------------------------------------------
    // Test 7: Normal Chat Endpoint Works Unchanged
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing normal chat endpoint operates without regression...");
    const chatRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: userAConvId,
        content: "Where did we leave off with billing?",
      }),
    });

    assert.equal(chatRes.status, 200);
    const chatJson = (await chatRes.json()) as any;
    assert.equal(chatJson.success, true);
    console.log("✓ Test 7 Passed: Normal chat operates completely unchanged");

    // -------------------------------------------------------------
    // Test 8: Streaming Chat Endpoint Works Unchanged
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing streaming chat endpoint operates without regression...");
    const streamRes = await fetch(`${baseUrl}/api/v1/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        conversationId: userAConvId,
        content: "Stream the next billing steps",
        stream: true,
      }),
    });

    assert.equal(streamRes.status, 200);
    const streamBody = await streamRes.text();
    assert.ok(streamBody.includes("Streaming agent test chunk"));
    console.log("✓ Test 8 Passed: Streaming chat operates completely unchanged");

    console.log("\n=============================================================");
    console.log("=== ALL AGENT SHARED CONTEXT TESTS PASSED (8/8) =============");
    console.log("=============================================================");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const users = await User.find({ email: { $in: [userAEmail, userBEmail] } });
      const ids = users.map((u) => u._id);
      if (ids.length > 0) {
        await Conversation.deleteMany({ userId: { $in: ids } });
        await Message.deleteMany({ userId: { $in: ids } });
        await Memory.deleteMany({ userId: { $in: ids } });
        await User.deleteMany({ _id: { $in: ids } });
      }
    } catch {}
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Agent Shared Context Test Suite Failed:", err);
  process.exit(1);
});
