import { describe, expect, it } from 'vitest';
import { createToolRegistry, defineTool } from '../../src/tools/registry.js';

describe('ToolRegistry listTools projection', () => {
  it('returns MCP/provider-ready descriptions with schemas and permission filtering', () => {
    const registry = createToolRegistry();
    registry.register(
      defineTool<Record<string, unknown>>({
        name: 'mission.task.update',
        summary: 'Update task',
        requiredPermissions: ['mission:write'],
        schema: {
          inputSchema: {
            type: 'object',
            required: ['taskId'],
            properties: { taskId: { type: 'string' } },
          },
          parse: (input) => input as Record<string, unknown>,
        },
        handler: () => ({ status: 'applied', summary: 'ok', effects: [] }),
      }),
    );
    registry.register(
      defineTool<Record<string, unknown>>({
        name: 'mission.phase.complete',
        summary: 'Complete phase',
        requiredPermissions: ['mission:admin'],
        schema: { parse: (input) => input as Record<string, unknown> },
        handler: () => ({ status: 'applied', summary: 'ok', effects: [] }),
      }),
    );

    const tools = registry.listTools({
      allowedNames: new Set(['mission.task.update', 'mission.phase.complete']),
      statePermissions: ['mission:write'],
    });

    expect(tools).toEqual([
      {
        name: 'mission.task.update',
        description: 'Update task',
        inputSchema: {
          type: 'object',
          required: ['taskId'],
          properties: { taskId: { type: 'string' } },
        },
        requiredPermissions: ['mission:write'],
      },
    ]);
  });
});
