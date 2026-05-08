// server/src/tools/registry.ts
//
// In-process registry of agent tool definitions. The registry is intentionally
// dumb: it only validates names and stores definitions. Schema validation,
// permission checks, and side effects all live in the execute pipeline.

import { hasStatePermissions, type StatePermission } from './permissions/state-permissions.js';
import type { AgentToolDefinition } from './types.js';

/**
 * Allowed top-level namespaces. Keep this aligned with the spec's namespace
 * list; adding a namespace here is a deliberate API surface change.
 */
const ALLOWED_NAMESPACES: ReadonlySet<string> = new Set([
  'agent',
  'mission',
  'collab',
  'permission',
  'search',
]);

/** Pattern for a single segment of a dotted tool name. */
const SEGMENT = /^[a-z][a-z0-9_]*$/;

/** Names must look like `mission.task.update`: 2+ segments, lower snake. */
export function isValidToolName(name: string): boolean {
  const segments = name.split('.');
  if (segments.length < 2) return false;
  const head = segments[0];
  if (head === undefined || !ALLOWED_NAMESPACES.has(head)) return false;
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) return false;
  }
  return true;
}

export interface ToolListEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredPermissions: StatePermission[];
}

export interface ToolListOptions {
  allowedNames?: ReadonlySet<string>;
  statePermissions?: readonly StatePermission[];
}

export interface ToolRegistry {
  register<TArgs>(definition: AgentToolDefinition<TArgs>): void;
  get(name: string): AgentToolDefinition | null;
  list(): AgentToolDefinition[];
  listTools(options?: ToolListOptions): ToolListEntry[];
  has(name: string): boolean;
}

class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();

  register<TArgs>(definition: AgentToolDefinition<TArgs>): void {
    if (!isValidToolName(definition.name)) {
      throw new Error(
        `invalid tool name: ${definition.name} (expected dotted lowercase, e.g. mission.task.update)`,
      );
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, definition as AgentToolDefinition);
  }

  get(name: string): AgentToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  list(): AgentToolDefinition[] {
    return Array.from(this.tools.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  listTools(options: ToolListOptions = {}): ToolListEntry[] {
    return this.list()
      .filter((tool) => {
        if (options.allowedNames && !options.allowedNames.has(tool.name)) return false;
        if (options.statePermissions === undefined) return true;
        return hasStatePermissions(options.statePermissions, tool.requiredPermissions);
      })
      .map((tool) => ({
        name: tool.name,
        description: tool.summary,
        inputSchema: tool.schema.inputSchema ?? { type: 'object', additionalProperties: true },
        requiredPermissions: [...tool.requiredPermissions],
      }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

/** Construct a fresh registry. Tests create their own; production uses a default. */
export function createToolRegistry(): ToolRegistry {
  return new InMemoryToolRegistry();
}

/** Helper for fluent definition without losing TArgs inference. */
export function defineTool<TArgs>(definition: AgentToolDefinition<TArgs>): AgentToolDefinition<TArgs> {
  return definition;
}

/**
 * Default process-wide registry. Production code (broker, adapters) reads from
 * this; tests should construct their own via `createToolRegistry()` to avoid
 * leaking state across cases.
 */
export const defaultToolRegistry: ToolRegistry = createToolRegistry();

/** Convenience wrappers around the default registry. */
export function registerTool<TArgs>(definition: AgentToolDefinition<TArgs>): void {
  defaultToolRegistry.register(definition);
}

export function getTool(name: string): AgentToolDefinition | null {
  return defaultToolRegistry.get(name);
}

export function listTools(options?: ToolListOptions): ToolListEntry[] {
  return defaultToolRegistry.listTools(options);
}
