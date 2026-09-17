import { AppError } from "../../errors/app.error.js";
import type { AgentTool } from "./tool.interface.js";

/**
 * In-memory registry for managing executable agent tools.
 */
export class ToolRegistry {
  private readonly tools: Map<string, AgentTool<any, any>> = new Map();

  /**
   * Registers a new agent tool.
   * Throws an AppError if the tool is invalid or a tool with the same name is already registered.
   */
  public register(tool: AgentTool<any, any>): void {
    if (!tool || typeof tool !== "object") {
      throw new AppError("Tool definition must be an object", 400, "INVALID_TOOL");
    }

    const name = tool.name?.trim();
    if (!name) {
      throw new AppError("Tool must have a valid non-empty name", 400, "INVALID_TOOL");
    }

    if (typeof tool.execute !== "function") {
      throw new AppError(
        `Tool "${name}" must implement an execute function`,
        400,
        "INVALID_TOOL",
      );
    }

    if (this.tools.has(name)) {
      throw new AppError(
        `Tool with name "${name}" is already registered`,
        409,
        "DUPLICATE_TOOL",
      );
    }

    this.tools.set(name, tool);
  }

  /**
   * Unregisters an agent tool by name.
   * Returns true if the tool was found and removed, false otherwise.
   */
  public unregister(name: string): boolean {
    const trimmed = name?.trim();
    if (!trimmed) {
      return false;
    }
    return this.tools.delete(trimmed);
  }

  /**
   * Retrieves an agent tool by name.
   */
  public get(name: string): AgentTool<any, any> | undefined {
    const trimmed = name?.trim();
    if (!trimmed) {
      return undefined;
    }
    return this.tools.get(trimmed);
  }

  /**
   * Checks whether a tool with the given name is registered.
   */
  public has(name: string): boolean {
    const trimmed = name?.trim();
    if (!trimmed) {
      return false;
    }
    return this.tools.has(trimmed);
  }

  /**
   * Returns a list of all currently registered agent tools.
   */
  public list(): AgentTool<any, any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Clears all registered tools from the in-memory registry.
   */
  public clear(): void {
    this.tools.clear();
  }

  /**
   * Gets the total number of registered tools.
   */
  public get size(): number {
    return this.tools.size;
  }
}

/**
 * Default global singleton instance of the ToolRegistry.
 */
export const toolRegistry = new ToolRegistry();

/**
 * Convenience helper to register a tool in the default global registry.
 */
export const registerTool = (tool: AgentTool<any, any>): void => {
  toolRegistry.register(tool);
};

/**
 * Convenience helper to unregister a tool by name in the default global registry.
 */
export const unregisterTool = (name: string): boolean => {
  return toolRegistry.unregister(name);
};

/**
 * Convenience helper to get a tool by name from the default global registry.
 */
export const getTool = (name: string): AgentTool<any, any> | undefined => {
  return toolRegistry.get(name);
};

/**
 * Convenience helper to check if a tool exists in the default global registry.
 */
export const hasTool = (name: string): boolean => {
  return toolRegistry.has(name);
};

/**
 * Convenience helper to list all registered tools from the default global registry.
 */
export const listTools = (): AgentTool<any, any>[] => {
  return toolRegistry.list();
};
