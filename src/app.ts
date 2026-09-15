import express from "express";
import userRoutes from "./modules/users/user.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import conversationRoutes from "./modules/conversations/conversation.routes.js";
import messageRoutes from "./modules/messages/message.routes.js";
import { errorHandler } from "./middleware/error-handler.js";

const app = express();

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

app.use(errorHandler);

export default app;