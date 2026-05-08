// server/src/tools/handlers/collab-tools.ts
//
// Tool handlers for `collab.note.add` and `collab.note.update`. The handlers
// reuse the existing collaboration-item repo so the tool layer behaves
// identically to the legacy `/collab-note` parser flow. Only `collab.note.add`
// is emitted by the hidden-command adapter (the legacy block has no `id`
// field); `collab.note.update` exists for direct/MCP callers.
//
// See docs/phase-4-permission-collab-design-2026-05-07.md for the full design.

import { createAgentRunAction } from '../../repos/run-actions.js';
import {
  createCollaborationItem,
  updateCollaborationItem,
} from '../../repos/collaboration.js';
import { defineTool } from '../registry.js';
import {
  defaultCollabNoteStatus,
  parseCollabNoteAddArgs,
  parseCollabNoteUpdateArgs,
  type CollabNoteAddArgs,
  type CollabNoteUpdateArgs,
} from '../schemas/collab.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

export function handleCollabNoteAdd(
  input: AgentToolHandlerInput<CollabNoteAddArgs>,
): AgentToolResult {
  const { args, call, db } = input;
  const status = args.status ?? defaultCollabNoteStatus(args.kind);
  const title = (args.title ?? args.body ?? args.kind).trim() || args.kind;

  const item = createCollaborationItem(db, {
    roomId: call.roomId,
    taskId: call.missionId,
    runId: call.runId,
    messageId: call.messageId,
    agentId: call.agentId,
    kind: args.kind,
    status,
    confidence: args.confidence ?? '',
    title,
    target: args.target ?? '',
    body: args.body ?? '',
    evidence: args.evidence ?? [],
  });

  createAgentRunAction(db, {
    roomId: call.roomId,
    taskId: call.missionId,
    runId: call.runId ?? call.id,
    agentId: call.agentId,
    kind: 'ledger',
    status: 'completed',
    label: `recorded ${args.kind}`,
    detail: title,
  });

  return {
    status: 'applied',
    summary: `collab.note.add applied: ${args.kind} ${title}`,
    data: { id: item.id, kind: item.kind, status: item.status },
    effects: [
      {
        kind: 'activity-created',
        targetType: 'collab-note',
        targetId: item.id,
        summary: `${args.kind}: ${title}`,
        payload: { id: item.id, kind: item.kind, status: item.status },
      },
    ],
  };
}

export function handleCollabNoteUpdate(
  input: AgentToolHandlerInput<CollabNoteUpdateArgs>,
): AgentToolResult {
  const { args, call, db } = input;
  const updated = updateCollaborationItem(db, args.id, {
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
    ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
  });

  if (!updated) {
    return {
      status: 'rejected',
      summary: `collab.note.update rejected: note ${args.id} not found`,
      effects: [],
    };
  }

  createAgentRunAction(db, {
    roomId: call.roomId,
    taskId: call.missionId,
    runId: call.runId ?? call.id,
    agentId: call.agentId,
    kind: 'ledger',
    status: 'completed',
    label: `updated ${updated.kind}`,
    detail: updated.title,
  });

  return {
    status: 'applied',
    summary: `collab.note.update applied: ${updated.kind} ${updated.title}`,
    data: { id: updated.id, status: updated.status },
    effects: [
      {
        kind: 'activity-created',
        targetType: 'collab-note',
        targetId: updated.id,
        summary: `${updated.kind} updated: ${updated.title}`,
        payload: { id: updated.id, kind: updated.kind, status: updated.status },
      },
    ],
  };
}

export const collabNoteAddTool = defineTool<CollabNoteAddArgs>({
  name: 'collab.note.add',
  summary: 'Record a collaboration note (proposal, challenge, revision, decision, evidence).',
  requiredPermissions: ['collab:write'],
  schema: { parse: parseCollabNoteAddArgs },
  handler: handleCollabNoteAdd,
});

export const collabNoteUpdateTool = defineTool<CollabNoteUpdateArgs>({
  name: 'collab.note.update',
  summary: 'Update an existing collaboration note (status, title, body, evidence, confidence).',
  requiredPermissions: ['collab:write'],
  schema: { parse: parseCollabNoteUpdateArgs },
  handler: handleCollabNoteUpdate,
});

export const collabTools = [collabNoteAddTool, collabNoteUpdateTool] as const;
