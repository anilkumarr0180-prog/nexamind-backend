import express from "express";
import cors from "cors";
import userRoutes from "./modules/users/user.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import conversationRoutes from "./modules/conversations/conversation.routes.js";
import messageRoutes from "./modules/messages/message.routes.js";
import { errorHandler } from "./middleware/error-handler.js";

const app = express();

// Enable CORS for all incoming requests
app.use(
  cors({
    origin: true, // Automatically reflects request origin (works with Postman & any frontend)
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

app.use(errorHandler);

export default app;