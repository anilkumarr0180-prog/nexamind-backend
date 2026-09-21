import { Polar } from "@polar-sh/sdk";
import { env } from "./env.js";

/**
 * Polar SDK Client configured for the Polar Sandbox environment.
 * Uses trusted POLAR_ACCESS_TOKEN from validated environment configuration.
 */
export const polarClient = new Polar({
  accessToken: env.POLAR_ACCESS_TOKEN,
  server: "sandbox",
});

export { Polar };
