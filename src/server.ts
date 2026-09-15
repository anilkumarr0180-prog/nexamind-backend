import app from "./app.js";
import { env } from "./config/env.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "./config/database.js";

const startServer = async (): Promise<void> => {
  try {
    await connectDatabase();

    const server = app.listen(env.PORT, () => {
      console.log(
        `NexaMind API running on http://localhost:${env.PORT}`,
      );
    });

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`${signal} received. Shutting down gracefully...`);

      server.close(async () => {
        try {
          await disconnectDatabase();

          console.log("NexaMind API shut down successfully");
          process.exit(0);
        } catch (error) {
          console.error(
            "Error during graceful shutdown:",
            error,
          );

          process.exit(1);
        }
      });
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });

    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } catch (error) {
    console.error("Failed to start NexaMind API:", error);
    process.exit(1);
  }
};

void startServer();