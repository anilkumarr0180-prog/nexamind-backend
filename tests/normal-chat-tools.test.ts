import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation, CONVERSATION_STATUSES } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import * as tokenService from "../src/modules/tokens/token.service.js";
import * as orchestratorService from "../src/modules/ai/orchestrator.service.js";
import { toolRegistry } from "../src/modules/agent/tool.registry.js";
import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIStreamChunk,
  ChatResponseOptions,
} from "../src/modules/ai/providers/ai-provider.interface.js";

/**
 * Controllable Mock AI Provider for deterministic testing of tool-calling in normal chat.
 */
class MockToolAwareAIProvider implements AIProvider {
  public readonly name = "mock-tool-provider";
  public calls: Array<{ messages: AIMessage[]; options?: ChatResponseOptions }> = [];
  public streamCalls = 0;
  public failOnGenerate = false;
  public loopInfinite = false;
  public toolDelayMs = 0;

  async generateChatResponse(
    messages: AIMessage[],
    options?: ChatResponseOptions,
  ): Promise<AIResponse> {
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)), options });

    if (this.toolDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.toolDelayMs));
    }
    if (this.failOnGenerate) {
      throw new Error("Simulated AI provider failure");
    }

    if (this.loopInfinite) {
      // Force continuous tool calling to test maxSteps protection
      return {
        content: "",
        provider: "mock-tool-provider",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        toolCalls: [
          {
            id: `infinite_call_${this.calls.length}`,
            name: "calculator",
            arguments: { expression: "1 + 1" },
          },
        ],
      };
    }

    // Check if the last message is a tool response
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === "tool") {
      let toolData: any = {};
      try {
        toolData = JSON.parse(lastMsg.content);
      } catch {
        toolData = { result: lastMsg.content };
      }

      if (toolData.error) {
        return {
          content: `Cannot calculate expression: ${toolData.error}`,
          provider: "mock-tool-provider",
          model: "mock-model",
          usage: { inputTokens: 25, outputTokens: 15, totalTokens: 40 },
        };
      }

      if (toolData.time || toolData.date || toolData.iso) {
        return {
          content: `The current time in ${toolData.timezone || "UTC"} is ${toolData.time} on ${toolData.date} (${toolData.dayOfWeek}).`,
          provider: "mock-tool-provider",
          model: "mock-model",
          usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
        };
      }

      if (toolData.category && toolData.fromUnit && toolData.toUnit) {
        return {
          content: `Converted ${toolData.value} ${toolData.fromUnit} to ${toolData.result} ${toolData.toUnit}.`,
          provider: "mock-tool-provider",
          model: "mock-model",
          usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
        };
      }

      return {
        content: `The calculated answer is ${toolData.result}.`,
        provider: "mock-tool-provider",
        model: "mock-model",
        usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      };
    }

    // Check user query for calculator requests
    const userMsg = messages.filter((m) => m.role === "user").pop();
    const query = userMsg?.content || "";

    if (toolRegistry.isToolRequired(query) && options?.tools && options.tools.length > 0) {
      const qLower = query.toLowerCase();
      if (qLower.includes("time") || qLower.includes("date") || qLower.includes("day")) {
        let timezone: string | undefined = undefined;
        if (qLower.includes("kolkata") || qLower.includes("india")) {
          timezone = "Asia/Kolkata";
        } else if (qLower.includes("london")) {
          timezone = "Europe/London";
        } else if (qLower.includes("new york") || qLower.includes("new_york")) {
          timezone = "America/New_York";
        }

        return {
          content: "",
          provider: "mock-tool-provider",
          model: "mock-model",
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          toolCalls: [
            {
              id: "call_datetime_test_1",
              name: "datetime",
              arguments: timezone ? { timezone } : {},
            },
          ],
        };
      }

      if (
        qLower.includes("convert") ||
        qLower.includes("how many") ||
        qLower.includes("to miles") ||
        qLower.includes("to celsius") ||
        qLower.includes("to feet") ||
        qLower.includes("to kilograms") ||
        qLower.includes("in miles") ||
        qLower.includes("in celsius") ||
        qLower.includes("in lbs") ||
        qLower.includes("pounds is 5") ||
        qLower.includes("10 km") ||
        qLower.includes("2 meters") ||
        qLower.includes("100 fahrenheit")
      ) {
        let value = 10;
        let fromUnit = "kilometer";
        let toUnit = "mile";

        if (qLower.includes("5 kg") || qLower.includes("5 kilograms") || qLower.includes("pounds is 5") || qLower.includes("5kg")) {
          value = 5;
          fromUnit = "kilogram";
          toUnit = "pound";
        } else if (qLower.includes("100 fahrenheit") || qLower.includes("100 f")) {
          value = 100;
          fromUnit = "fahrenheit";
          toUnit = "celsius";
        } else if (qLower.includes("2 meters") || qLower.includes("2 m")) {
          value = 2;
          fromUnit = "meter";
          toUnit = "foot";
        } else if (qLower.includes("500 grams") || qLower.includes("500g")) {
          value = 500;
          fromUnit = "gram";
          toUnit = "kilogram";
        }

        return {
          content: "",
          provider: "mock-tool-provider",
          model: "mock-model",
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          toolCalls: [
            {
              id: "call_unit_conv_test_1",
              name: "unit_conversion",
              arguments: { value, fromUnit, toUnit },
            },
          ],
        };
      }

      let expression = "1542 * 38";
      if (query.includes("10 / 0")) {
        expression = "10 / 0";
      } else if (query.includes("1542 * 38")) {
        expression = "1542 * 38";
      } else if (query.includes("99 + 1")) {
        expression = "99 + 1";
      }

      return {
        content: "",
        provider: "mock-tool-provider",
        model: "mock-model",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        toolCalls: [
          {
            id: "call_calc_test_1",
            name: "calculator",
            arguments: { expression },
          },
        ],
      };
    }

    return {
      content: "Standard response without any tools.",
      provider: "mock-tool-provider",
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    };
  }

  async *generateChatStream(
    messages: AIMessage[],
    options?: ChatResponseOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.streamCalls++;

    const lastMsg = messages[messages.length - 1];
    let text = "Standard streamed response without tools.";

    if (lastMsg && lastMsg.role === "tool") {
      let toolData: any = {};
      try {
        toolData = JSON.parse(lastMsg.content);
      } catch {
        toolData = { result: lastMsg.content };
      }
      if (toolData.error) {
        text = `Cannot calculate expression: ${toolData.error}`;
      } else if (toolData.time || toolData.date || toolData.iso) {
        text = `The current time in ${toolData.timezone || "UTC"} is ${toolData.time} on ${toolData.date} (${toolData.dayOfWeek}).`;
      } else if (toolData.category && toolData.fromUnit && toolData.toUnit) {
        text = `Converted ${toolData.value} ${toolData.fromUnit} to ${toolData.result} ${toolData.toUnit}.`;
      } else {
        text = `The calculated answer is ${toolData.result}.`;
      }
    }

    const words = text.split(" ");
    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal?.aborted) return;
      yield {
        content: (i > 0 ? " " : "") + words[i],
        model: "mock-model",
      };
    }

    yield {
      content: "",
      model: "mock-model",
      usage: { inputTokens: 15, outputTokens: 20, totalTokens: 35 },
      done: true,
    };
  }
}

const runTests = async () => {
  console.log("=== Starting Normal Chat + Agent Infrastructure Integration Tests ===");
  await connectDatabase();

  const mockProvider = new MockToolAwareAIProvider();
  orchestratorService.setDefaultProvider(mockProvider);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 5000;
  const baseUrl = `http://127.0.0.1:${port}`;

  const testId = Date.now();
  const userAEmail = `chat_tools_user_a_${testId}@example.com`;
  const userBEmail = `chat_tools_user_b_${testId}@example.com`;
  const password = "Password123!@#$";

  let userAId = "";
  let userAToken = "";
  let userBId = "";
  let userBToken = "";
  let convAId = "";

  try {
    // Setup users
    const regA = await authService.register({ email: userAEmail, password });
    userAId = regA.user.id;
    userAToken = regA.accessToken;

    const regB = await authService.register({ email: userBEmail, password });
    userBId = regB.user.id;
    userBToken = regB.accessToken;

    // Create conversation for User A
    const convA = await Conversation.create({
      userId: userAId,
      title: "Tools Test Chat",
      status: CONVERSATION_STATUSES.ACTIVE,
    });
    convAId = convA._id.toString();

    console.log(`✓ Test environment ready (User A: ${userAId}, User B: ${userBId}, Conv A: ${convAId})`);

    // -------------------------------------------------------------
    // Test 1: Normal chat without tools -> existing behavior unchanged
    // -------------------------------------------------------------
    console.log("\n[Test 1] Normal chat without tools -> standard provider path...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);
      mockProvider.calls = [];
      mockProvider.streamCalls = 0;

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Tell me a joke",
        }),
      });

      assert.equal(res.status, 200, "Should return 200 OK");
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.assistantMessage.content, "Standard response without any tools.");

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Credits deducted exactly once (1 credit)");
      console.log("✓ Test 1 Passed: Normal chat without tools operated unchanged with 1 credit deducted");
    }

    // -------------------------------------------------------------
    // Test 2: Normal chat requiring calculator (non-streaming)
    // -------------------------------------------------------------
    console.log("\n[Test 2] Normal chat requiring calculator (non-streaming) -> uses ToolRegistry & CalculatorTool...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);
      mockProvider.calls = [];

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Calculate 1542 * 38",
        }),
      });

      assert.equal(res.status, 200, "Should return 200 OK");
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.assistantMessage.content.includes("58596"), "Response must contain calculation 58596");

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Credits deducted exactly once for tool chat");

      // Verify messages persisted to MongoDB
      const msgs = await Message.find({ conversationId: convAId }).sort({ createdAt: 1 });
      const lastUser = msgs[msgs.length - 2];
      const lastAssistant = msgs[msgs.length - 1];
      assert.equal(lastUser.content, "Calculate 1542 * 38");
      assert.ok(lastAssistant.content.includes("58596"));

      console.log("✓ Test 2 Passed: Normal chat executed CalculatorTool via ToolRegistry and returned 58596");
    }

    // -------------------------------------------------------------
    // Test 3: Normal chat requiring calculator (STREAMING) with SSE events
    // -------------------------------------------------------------
    console.log("\n[Test 3] Normal chat requiring calculator (streaming) -> emits tool_status and status events...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Calculate 1542 * 38",
          stream: true,
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

      const text = await res.text();
      const events: any[] = [];
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {}
        }
      }

      const types = events.map((e) => e.type);
      assert.ok(types.includes("start"), "Must include start event");
      assert.ok(types.includes("status"), "Must include status event");
      assert.ok(types.includes("tool_status"), "Must include tool_status event");
      assert.ok(types.includes("chunk"), "Must include chunk event");
      assert.ok(types.includes("done"), "Must include done event");

      // Verify tool_status events show calculator running and completed
      const toolEvents = events.filter((e) => e.type === "tool_status");
      assert.ok(toolEvents.some((e) => e.tool === "calculator" && e.status === "running"), "Emits tool running");
      assert.ok(toolEvents.some((e) => e.tool === "calculator" && e.status === "completed"), "Emits tool completed");

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Credits deducted exactly once for streaming tool chat");
      console.log("✓ Test 3 Passed: Streaming normal chat emitted tool_status, status, chunks, and done events");
    }

    // -------------------------------------------------------------
    // Test 4: Tool failure is handled safely (division by zero)
    // -------------------------------------------------------------
    console.log("\n[Test 4] Tool failure handling (Calculate 10 / 0) -> normalized error and AI explanation...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Calculate 10 / 0",
        }),
      });

      assert.equal(res.status, 200, "Should return 200 OK without crashing");
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(
        json.data.assistantMessage.content.toLowerCase().includes("zero") ||
        json.data.assistantMessage.content.toLowerCase().includes("undefined"),
        "AI explains division by zero gracefully",
      );

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Credits deducted for successful natural explanation");
      console.log("✓ Test 4 Passed: Tool failure handled safely without crashing and explained to user");
    }

    // -------------------------------------------------------------
    // Test 5: Explicit /api/v1/agent/run still works
    // -------------------------------------------------------------
    console.log("\n[Test 5] Explicit /api/v1/agent/run endpoint still works...");
    {
      const res = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          task: "Calculate 1542 * 38",
          conversationId: convAId,
        }),
      });

      assert.equal(res.status, 200, "Explicit agent run must return 200 OK");
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.output.includes("58596"));
      console.log("✓ Test 5 Passed: Explicit /api/v1/agent/run operates properly");
    }

    // -------------------------------------------------------------
    // Test 6: maxSteps prevents infinite loops
    // -------------------------------------------------------------
    console.log("\n[Test 6] maxSteps enforcement prevents infinite loops...");
    {
      mockProvider.loopInfinite = true;
      const balanceBefore = await tokenService.getBalance(userAId);

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Calculate 99 + 1",
        }),
      });

      mockProvider.loopInfinite = false;

      // Because maxSteps (10) was reached with no output, it fails cleanly with 502
      assert.equal(res.status, 502);
      const json = await res.json();
      assert.ok(json.error?.message?.includes("Maximum execution steps"));

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal(balanceBefore.balance, balanceAfter.balance, "Credit refunded when execution hits maxSteps failure");
      console.log("✓ Test 6 Passed: maxSteps halted infinite tool bouncing and refunded credits");
    }

    // -------------------------------------------------------------
    // Test 7: Cross-user conversation isolation
    // -------------------------------------------------------------
    console.log("\n[Test 7] Cross-user isolation: User B cannot access User A conversation...");
    {
      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userBToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Calculate 1542 * 38",
        }),
      });

      assert.equal(res.status, 404, "Must reject cross-user access with 404");
      console.log("✓ Test 7 Passed: Strict cross-user conversation isolation enforced");
    }

    // -------------------------------------------------------------
    // Test 8: Failed execution refunds credits
    // -------------------------------------------------------------
    console.log("\n[Test 8] Provider failure during tool request refunds credits...");
    {
      mockProvider.failOnGenerate = true;
      const balanceBefore = await tokenService.getBalance(userAId);

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Calculate 1542 * 38",
        }),
      });

      mockProvider.failOnGenerate = false;
      assert.equal(res.status, 502);

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal(balanceBefore.balance, balanceAfter.balance, "Credit refunded after provider failure");
      console.log("✓ Test 8 Passed: Provider failure refunded credits correctly");
    }

    // -------------------------------------------------------------
    // Test 9: Aborted execution before content refunds credits
    // -------------------------------------------------------------
    console.log("\n[Test 9] Client abort before content refunds credits...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);
      const abortController = new AbortController();
      abortController.abort(); // Pre-aborted signal

      const result = await orchestratorService.processChatStream(
        userAId,
        {
          conversationId: convAId,
          content: "Calculate 1542 * 38",
        },
        {
          onChunk: () => {},
        },
        abortController.signal,
        mockProvider,
      );

      assert.equal(result, null, "Aborted stream before content must return null");

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal(balanceBefore.balance, balanceAfter.balance, "Credit refunded when aborted before content");

      // Verify the user message was marked FAILED
      const lastMsg = await Message.findOne({ conversationId: convAId }).sort({ createdAt: -1 });
      assert.equal(lastMsg?.status, MESSAGE_STATUSES.FAILED, "User message marked FAILED on abort before content");
      console.log("✓ Test 9 Passed: Aborted execution refunded credits and marked user message FAILED");
    }

    // -------------------------------------------------------------
    // Test 10: Edit & regenerate with tools works cleanly
    // -------------------------------------------------------------
    console.log("\n[Test 10] Edit & regenerate branching with tools works without duplicate deduction...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);
      const allMsgs = await Message.find({ conversationId: convAId, role: "USER", status: MESSAGE_STATUSES.COMPLETED }).sort({ createdAt: -1 });
      const msgToEdit = allMsgs[0];

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Calculate 1542 * 38",
          editMessageId: msgToEdit._id.toString(),
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.assistantMessage.content.includes("58596"));

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Exactly 1 credit deducted on edit-regenerate with tools");
      console.log("✓ Test 10 Passed: Edit & regenerate with tools executed cleanly without duplicate deduction");
    }

    // -------------------------------------------------------------
    // Test 11: Normal chat triggering DateTimeTool (non-streaming)
    // -------------------------------------------------------------
    console.log("\n[Test 11] Normal chat requiring DateTimeTool (Asia/Kolkata)...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);
      mockProvider.calls = [];

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "What time is it in Asia/Kolkata?",
        }),
      });

      assert.equal(res.status, 200, "Should return 200 OK");
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.assistantMessage.content.includes("Asia/Kolkata"), "Response must mention Asia/Kolkata");
      assert.ok(/\d{2}:\d{2}:\d{2}/.test(json.data.assistantMessage.content), "Response must contain formatted time HH:MM:SS");

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Credits deducted exactly once for DateTime tool chat");
      console.log("✓ Test 11 Passed: Normal chat executed DateTimeTool and returned accurate timezone time");
    }

    // -------------------------------------------------------------
    // Test 12: Normal chat triggering DateTimeTool (STREAMING)
    // -------------------------------------------------------------
    console.log("\n[Test 12] Normal chat requiring DateTimeTool (streaming) -> emits tool_status for datetime...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "What time is it in London?",
          stream: true,
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

      const text = await res.text();
      const events: any[] = [];
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {}
        }
      }

      const types = events.map((e) => e.type);
      assert.ok(types.includes("start"), "Must include start event");
      assert.ok(types.includes("status"), "Must include status event");
      assert.ok(types.includes("tool_status"), "Must include tool_status event");
      assert.ok(types.includes("chunk"), "Must include chunk event");
      assert.ok(types.includes("done"), "Must include done event");

      const toolEvents = events.filter((e) => e.type === "tool_status");
      assert.ok(toolEvents.some((e) => e.tool === "datetime" && e.status === "running"), "Emits datetime tool running");
      assert.ok(toolEvents.some((e) => e.tool === "datetime" && e.status === "completed"), "Emits datetime tool completed");

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Credits deducted exactly once for streaming DateTime chat");
      console.log("✓ Test 12 Passed: Streaming normal chat emitted tool_status (running & completed) for datetime");
    }

    // -------------------------------------------------------------
    // Test 13: Normal non-date/time query does NOT trigger DateTimeTool
    // -------------------------------------------------------------
    console.log("\n[Test 13] Normal non-temporal query (What is JavaScript?) does NOT trigger DateTimeTool...");
    {
      assert.equal(toolRegistry.isToolRequired("What is JavaScript?"), false, "isToolRequired must be false for non-tool query");
      assert.equal(toolRegistry.isToolRequired("Tell me a story"), false);
      assert.equal(toolRegistry.isToolRequired("Explain quantum mechanics"), false);

      const balanceBefore = await tokenService.getBalance(userAId);
      mockProvider.calls = [];

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "What is JavaScript?",
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.assistantMessage.content, "Standard response without any tools.");

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Standard 1 credit deducted");
      console.log("✓ Test 13 Passed: Non-temporal query bypassed tool loop and did not invoke DateTimeTool");
    }

    // -------------------------------------------------------------
    // Test 14: Explicit /api/v1/agent/run with DateTimeTool
    // -------------------------------------------------------------
    console.log("\n[Test 14] Explicit /api/v1/agent/run mode with DateTimeTool...");
    {
      const res = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          task: "What is today's date?",
          conversationId: convAId,
        }),
      });

      assert.equal(res.status, 200, "Explicit agent run must return 200 OK");
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.output.includes("UTC") || /\d{4}-\d{2}-\d{2}/.test(json.data.output), "Output contains date data");
      console.log("✓ Test 14 Passed: Explicit /api/v1/agent/run executed DateTimeTool seamlessly");
    }

    // -------------------------------------------------------------
    // Test 15: Normal chat triggering UnitConversionTool (non-streaming)
    // -------------------------------------------------------------
    console.log("\n[Test 15] Normal chat requiring UnitConversionTool (10 km to miles)...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);
      mockProvider.calls = [];

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "Convert 10 kilometers to miles",
        }),
      });

      assert.equal(res.status, 200, "Should return 200 OK");
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.assistantMessage.content.includes("6.213712"), "Response must contain converted result 6.213712");
      assert.ok(json.data.assistantMessage.content.includes("mile"), "Response must mention target unit mile");

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Credits deducted exactly once for UnitConversionTool chat");
      console.log("✓ Test 15 Passed: Normal chat executed UnitConversionTool and returned accurate converted result");
    }

    // -------------------------------------------------------------
    // Test 16: Normal chat triggering UnitConversionTool (STREAMING)
    // -------------------------------------------------------------
    console.log("\n[Test 16] Normal chat requiring UnitConversionTool (streaming: 5 kg to pounds) -> emits tool_status for unit_conversion...");
    {
      const balanceBefore = await tokenService.getBalance(userAId);

      const res = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          conversationId: convAId,
          content: "How many pounds is 5 kilograms?",
          stream: true,
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

      const text = await res.text();
      const events: any[] = [];
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {}
        }
      }

      const types = events.map((e) => e.type);
      assert.ok(types.includes("start"), "Must include start event");
      assert.ok(types.includes("status"), "Must include status event");
      assert.ok(types.includes("tool_status"), "Must include tool_status event");
      assert.ok(types.includes("chunk"), "Must include chunk event");
      assert.ok(types.includes("done"), "Must include done event");

      const toolEvents = events.filter((e) => e.type === "tool_status");
      assert.ok(toolEvents.some((e) => e.tool === "unit_conversion" && e.status === "running"), "Emits unit_conversion tool running");
      assert.ok(toolEvents.some((e) => e.tool === "unit_conversion" && e.status === "completed"), "Emits unit_conversion tool completed");

      const balanceAfter = await tokenService.getBalance(userAId);
      assert.equal((balanceBefore.balance - balanceAfter.balance), 1, "Credits deducted exactly once for streaming UnitConversion chat");
      console.log("✓ Test 16 Passed: Streaming normal chat emitted tool_status (running & completed) for unit_conversion");
    }

    // -------------------------------------------------------------
    // Test 17: Multi-Tool Isolation (Calculator, DateTime, UnitConversion)
    // -------------------------------------------------------------
    console.log("\n[Test 17] Verifying distinct tool selection across Calculator, DateTime, and UnitConversion...");
    {
      assert.equal(toolRegistry.isToolRequired("Calculate 1542 * 38"), true);
      assert.equal(toolRegistry.isToolRequired("What time is it?"), true);
      assert.equal(toolRegistry.isToolRequired("Convert 10 km to miles"), true);
      assert.equal(toolRegistry.isToolRequired("What is JavaScript?"), false);
      assert.equal(toolRegistry.isToolRequired("Explain React hooks"), false);
      assert.equal(toolRegistry.isToolRequired("Tell me about MongoDB"), false);
      console.log("✓ Test 17 Passed: Multi-tool selection accurately matches intended tools without false triggers");
    }

    // -------------------------------------------------------------
    // Test 18: Explicit /api/v1/agent/run mode with UnitConversionTool
    // -------------------------------------------------------------
    console.log("\n[Test 18] Explicit /api/v1/agent/run mode with UnitConversionTool (100 F to C)...");
    {
      const res = await fetch(`${baseUrl}/api/v1/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          task: "Convert 100 Fahrenheit to Celsius",
          conversationId: convAId,
        }),
      });

      assert.equal(res.status, 200, "Explicit agent run must return 200 OK");
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.output.includes("37.777778"), "Output contains converted 37.777778 C");
      console.log("✓ Test 18 Passed: Explicit /api/v1/agent/run executed UnitConversionTool seamlessly");
    }

    console.log("\n==================================================");
    console.log(" ALL 18 INTEGRATION SCENARIOS PASSED (18/18)     ");
    console.log("==================================================");
  } finally {
    if (userAId) {
      await TokenBalance.deleteMany({ userId: { $in: [userAId, userBId] } });
      await Conversation.deleteMany({ _id: convAId });
      await Message.deleteMany({ conversationId: convAId });
      await User.deleteMany({ _id: { $in: [userAId, userBId] } });
    }
    server.close();
    await disconnectDatabase();
  }
};

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
