import mongoose from "mongoose";
import { env } from "./env.js";

export const connectDatabase = async (): Promise<void> => {
  try {
    await mongoose.connect(env.MONGODB_URI);

    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
};

mongoose.connection.on("connected", () => {
  console.log("MongoDB connection established");
});

mongoose.connection.on("error", (error) => {
  console.error("MongoDB connection error:", error);
});

mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected");
});

export const disconnectDatabase = async (): Promise<void> => {
  await mongoose.disconnect();

  console.log("MongoDB disconnected successfully");
};