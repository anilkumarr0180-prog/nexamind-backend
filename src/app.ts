import express from "express";
import morgan from "morgan";
import cors from "cors";
import { env } from "./config/env.js";
import userRoutes from "./modules/users/user.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import conversationRoutes from "./modules/conversations/conversation.routes.js";
import messageRoutes from "./modules/messages/message.routes.js";
import tokenRoutes from "./modules/tokens/token.routes.js";
import aiRoutes from "./modules/ai/ai.routes.js";
import memoryRoutes from "./modules/memory/memory.routes.js";
import { errorHandler } from "./middleware/error-handler.js";

const app = express();

app.use(morgan("dev"));
// Enable CORS with explicit allowlist from environment
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);


app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "NexaMind API is healthy",
  });
});

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/conversations", conversationRoutes);
app.use("/api/v1", messageRoutes);
app.use("/api/v1/tokens", tokenRoutes);
app.use("/api/v1/ai", aiRoutes);
app.use("/api/v1/memories", memoryRoutes);

app.use(errorHandler);

export default app;