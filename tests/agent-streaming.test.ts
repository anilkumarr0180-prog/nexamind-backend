import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { User } from "../src/modules/users/user.model.js";
import { Conversation, CONVERSATION_STATUSES } from "../src/modules/conversations/conversation.model.js";
import { Message, MESSAGE_ROLES, MESSAGE_STATUSES } from "../src/modules/messages/message.model.js";
import { TokenBalance } from "../src/modules/tokens/token.model.js";
import * as authService from "../src/modules/auth/auth.service.js";
import {
  AgentService,
  setAgentService,
  agentService,
  AGENT_STATUSES,
  TOOL_CALL_STATUSES,
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

/**
 * Controllable Mock Streaming AI Provider for Agent testing
 */
class MockAgentStreamingProvider implements AIProvider {
  public readonly name = "mock-agent-streaming-provider";
  public calls: Array<{ messages: AIMessage[]; options?: ChatResponseOptions }> = [];
  public streamDelayMs = 15;
  public failOnStream = false;

  private readonly responseHandler: (
    messages: AIMessage[],
    options?: ChatResponseOptions,
    callIndex: number,
  ) => Promise<AIResponse> | AIResponse;

  constructor(
    responseHandler: (
      messages: AIMessage[],
      options?: ChatResponseOptions,
      callIndex: number,
    ) => Promise<AIResponse> | AIResponse,
  ) {
    this.responseHandler = responseHandler;
  }

  async generateChatResponse(
    messages: AIMessage[],
    options?: ChatResponseOptions,
  ): Promise<AIResponse> {
    const callIndex = this.calls.length;
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)), options });
    return this.responseHandler(messages, options, callIndex);
  }

  async *generateChatStream(
    messages: AIMessage[],
    _options?: ChatResponseOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AIStreamChunk, void, unknown> {
    if (this.failOnStream) {
      throw new Error("Simulated upstream stream error");
    }

    const chunks = ["The calculated ", "result is 42. ", "Have a great day!"];
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) return;
      if (this.streamDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.streamDelayMs));
      }
      if (signal?.aborted) return;
      yield {
        content: chunks[i]!,
        model: "mock-model",
      };
    }

    yield {
      content: "",
      model: "mock-model",
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
      done: true,
    };
  }
}

/**
 * Helper to parse SSE stream from HTTP response
 */
const readSseEvents = async (
  res: http.IncomingMessage,
): Promise<Array<{ type: string; [key: string]: any }>> => {
  return new Promise((resolve, reject) => {
    const events: Array<{ type: string; [key: string]: any }> = [];
    let buffer = "";

    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        for (const line of trimmed.split("\n")) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            try {
              events.push(JSON.parse(dataStr));
            } catch (err) {
              // ignore partial parse
            }
          }
        }
      }
    });

    res.on("end", () => resolve(events));
    res.on("error", reject);
  });
};

const runTests = async () => {
  console.log("=== Starting Agent Streaming & Stop Agent Test Suite ===");
  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Setup test user
  const email = `agent_stream_user_${Date.now()}@test.com`;
  const registerResult = await authService.register({
    email,
    password: "Password123!",
  });
  const token = registerResult.accessToken;
  const userId = registerResult.user.id;
  console.log(`✓ Test user created: ${userId}`);

  // --------------------------------------------------------------------------
  // Test 1: Full Agent Streaming with Calculator Tool and Status Events
  // --------------------------------------------------------------------------
  console.log("\n[Test 1] Testing Agent streaming with tool status events and chunk delivery...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const mockProvider = new MockAgentStreamingProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
          toolCalls: [
            {
              id: "call_calc_1",
              name: "calculator",
              arguments: { expression: "6 * 7" },
            },
          ],
        };
      }
      return {
        content: "The calculated result is 42.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
      };
    });

    const testService = new AgentService({
      provider: mockProvider,
      registry,
    });
    setAgentService(testService);

    // Create a conversation
    const conv = await Conversation.create({
      userId,
      title: "Agent Stream Test",
      status: CONVERSATION_STATUSES.ACTIVE,
      messageCount: 0,
    });

    const postData = JSON.stringify({
      task: "What is 6 * 7?",
      conversationId: conv._id.toString(),
      stream: true,
    });

    const events = await new Promise<any[]>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/v1/agent/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        async (res) => {
          assert.equal(res.statusCode, 200);
          assert.ok(res.headers["content-type"]?.includes("text/event-stream"));
          try {
            const evts = await readSseEvents(res);
            resolve(evts);
          } catch (err) {
            reject(err);
          }
        },
      );
      req.on("error", reject);
      req.write(postData);
      req.end();
    });

    // Verify events sequence
    const types = events.map((e) => e.type);
    assert.ok(types.includes("start"), "Must include start event");
    assert.ok(types.includes("status"), "Must include status event");
    assert.ok(types.includes("tool_status"), "Must include tool_status event");
    assert.ok(types.includes("chunk"), "Must include chunk events");
    assert.ok(types.includes("done"), "Must include done event");

    // Verify safe tool status: tool running, tool completed
    const toolEvents = events.filter((e) => e.type === "tool_status");
    assert.ok(toolEvents.length >= 2, "Must have tool running and completed events");
    assert.equal(toolEvents[0].tool, "calculator");
    assert.equal(toolEvents[0].status, "running");
    assert.equal(toolEvents[1].tool, "calculator");
    assert.equal(toolEvents[1].status, "completed");

    // Verify generating status
    const statusEvents = events.filter((e) => e.type === "status");
    const generatingEvent = statusEvents.find((e) => e.status === "generating");
    assert.ok(generatingEvent, "Must emit generating response status");

    // Verify chunks
    const chunkEvents = events.filter((e) => e.type === "chunk");
    assert.ok(chunkEvents.length > 0, "Must receive streaming chunks");
    const fullText = chunkEvents.map((c) => c.content).join("");
    assert.ok(fullText.includes("42"), "Streamed text must contain result 42");

    // Verify DB persistence
    const messages = await Message.find({ conversationId: conv._id }).sort({ createdAt: 1 });
    assert.equal(messages.length, 2, "Must persist user message and assistant message");
    assert.equal(messages[0].role, MESSAGE_ROLES.USER);
    assert.equal(messages[1].role, MESSAGE_ROLES.ASSISTANT);
    assert.ok(messages[1].content.includes("42"));

    console.log("✓ Agent streaming with tool status events, chunk delivery, and message persistence verified");
  }

  // --------------------------------------------------------------------------
  // Test 2: Tool Failure Handling during Streaming
  // --------------------------------------------------------------------------
  console.log("\n[Test 2] Testing Tool failure event emission and safe recovery...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const mockProvider = new MockAgentStreamingProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCalls: [
            {
              id: "call_fail_1",
              name: "calculator",
              arguments: { expression: "100 / 0" }, // division by zero
            },
          ],
        };
      }
      return {
        content: "Division by zero is undefined.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
      };
    });

    const testService = new AgentService({
      provider: mockProvider,
      registry,
    });
    setAgentService(testService);

    const postData = JSON.stringify({
      task: "Calculate 100 / 0",
      stream: true,
    });

    const events = await new Promise<any[]>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/v1/agent/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        async (res) => {
          assert.equal(res.statusCode, 200);
          try {
            const evts = await readSseEvents(res);
            resolve(evts);
          } catch (err) {
            reject(err);
          }
        },
      );
      req.on("error", reject);
      req.write(postData);
      req.end();
    });

    const toolEvents = events.filter((e) => e.type === "tool_status");
    const failedEvent = toolEvents.find((e) => e.status === "failed");
    assert.ok(failedEvent, "Must emit tool failed event");
    assert.equal(failedEvent.tool, "calculator");
    assert.ok(failedEvent.error?.includes("Division by zero"));

    const doneEvent = events.find((e) => e.type === "done");
    assert.ok(doneEvent, "Must complete cleanly after tool failure recovery");
    console.log("✓ Tool failure event emitted and cleanly recovered");
  }

  // --------------------------------------------------------------------------
  // Test 3: Stop Agent / Request Cancellation
  // --------------------------------------------------------------------------
  console.log("\n[Test 3] Testing Stop Agent / AbortController cancellation...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const mockProvider = new MockAgentStreamingProvider(async (messages, options, callIndex) => {
      if (callIndex === 0) {
        return {
          content: "",
          provider: "mock",
          model: "mock-model",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCalls: [
            {
              id: "call_long_1",
              name: "calculator",
              arguments: { expression: "2 + 2" },
            },
          ],
        };
      }
      return {
        content: "Result is 4",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    });
    mockProvider.streamDelayMs = 100; // slow stream to guarantee cancellation mid-stream

    const testService = new AgentService({
      provider: mockProvider,
      registry,
    });
    setAgentService(testService);

    const conv = await Conversation.create({
      userId,
      title: "Agent Cancel Test",
      status: CONVERSATION_STATUSES.ACTIVE,
      messageCount: 0,
    });

    const postData = JSON.stringify({
      task: "Compute and stream slowly",
      conversationId: conv._id.toString(),
      stream: true,
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/v1/agent/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          let receivedChunks = 0;
          res.on("data", (chunk: Buffer) => {
            const str = chunk.toString();
            if (str.includes('"type":"chunk"')) {
              receivedChunks++;
              // Abort request after receiving first chunk
              req.destroy();
              setTimeout(resolve, 60);
            }
          });
        },
      );
      req.on("error", (err: any) => {
        // req.destroy will trigger ECONNRESET or similar client error
        if (err.code === "ECONNRESET") {
          resolve();
        }
      });
      req.write(postData);
      req.end();
    });

    // Verify cancellation handled safely without server crash
    await new Promise((resolve) => setTimeout(resolve, 80));
    console.log("✓ Stop Agent cancellation aborted cleanly without server crash");
  }

  // --------------------------------------------------------------------------
  // Test 4: Provider Failure Handling during Stream
  // --------------------------------------------------------------------------
  console.log("\n[Test 4] Testing upstream provider failure handling...");
  {
    const registry = new ToolRegistry();
    const mockProvider = new MockAgentStreamingProvider(async () => {
      throw new Error("Simulated upstream provider outage");
    });

    const testService = new AgentService({
      provider: mockProvider,
      registry,
    });
    setAgentService(testService);

    const postData = JSON.stringify({
      task: "Task with failing provider",
      stream: true,
    });

    const events = await new Promise<any[]>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/v1/agent/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        async (res) => {
          try {
            const evts = await readSseEvents(res);
            resolve(evts);
          } catch (err) {
            reject(err);
          }
        },
      );
      req.on("error", reject);
      req.write(postData);
      req.end();
    });

    const errorEvent = events.find((e) => e.type === "error");
    assert.ok(errorEvent, "Must emit SSE error event on provider failure");
    assert.ok(errorEvent.error.message.includes("outage") || errorEvent.error.code === "AGENT_EXECUTION_ERROR");
    console.log("✓ Upstream provider failure safely serialized into clean user-facing error event");
  }

  // --------------------------------------------------------------------------
  // Test 5: Conversation Isolation
  // --------------------------------------------------------------------------
  console.log("\n[Test 5] Testing conversation isolation...");
  {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);

    const mockProvider = new MockAgentStreamingProvider(async () => ({
      content: "Isolated execution completed",
      provider: "mock",
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }));

    const testService = new AgentService({
      provider: mockProvider,
      registry,
    });
    setAgentService(testService);

    const convA = await Conversation.create({
      userId,
      title: "Conversation A",
      status: CONVERSATION_STATUSES.ACTIVE,
      messageCount: 0,
    });

    const convB = await Conversation.create({
      userId,
      title: "Conversation B",
      status: CONVERSATION_STATUSES.ACTIVE,
      messageCount: 0,
    });

    const postDataA = JSON.stringify({
      task: "Task in Conversation A",
      conversationId: convA._id.toString(),
      stream: true,
    });

    const eventsA = await new Promise<any[]>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/v1/agent/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
            "Content-Length": Buffer.byteLength(postDataA),
          },
        },
        async (res) => {
          try {
            const evts = await readSseEvents(res);
            resolve(evts);
          } catch (err) {
            reject(err);
          }
        },
      );
      req.on("error", reject);
      req.write(postDataA);
      req.end();
    });

    const startEventA = eventsA.find((e) => e.type === "start");
    assert.equal(startEventA?.conversationId, convA._id.toString());

    // Messages in Conv A
    const messagesA = await Message.find({ conversationId: convA._id });
    assert.equal(messagesA.length, 2);

    // Messages in Conv B must be 0
    const messagesB = await Message.find({ conversationId: convB._id });
    assert.equal(messagesB.length, 0, "Conversation B must remain completely untouched");

    console.log("✓ Conversation isolation verified: no cross-conversation leakage or state interference");
  }

  // Cleanup
  setAgentService(agentService);
  server.close();
  await disconnectDatabase();
  console.log("\n==================================================");
  console.log(" ALL AGENT STREAMING TESTS PASSED (5/5)          ");
  console.log("==================================================\n");
};

runTests().catch((err) => {
  console.error("Agent Streaming Tests Failed:", err);
  process.exit(1);
});
