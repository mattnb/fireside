import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';
import type { ParsedCollaborationNote } from '../collaboration-notes.js';
import {
  createCollaborationItem,
  type CollaborationItem,
} from '../repos/collaboration.js';
import type { CreateAgentRunActionInput } from '../repos/run-actions.js';

export interface StoreCollaborationNotesInput {
  db: Database;
  roomId: string;
  taskId: string | null;
  runId: string;
  messageId: string | null;
  agentId: AgentId;
  notes: ParsedCollaborationNote[];
  recordRunAction: (input: CreateAgentRunActionInput) => void;
  onCollaborationItemCreated?: (item: CollaborationItem) => void;
}

export function storeCollaborationNotes(input: StoreCollaborationNotesInput): void {
  for (const note of input.notes) {
    const item = createCollaborationItem(input.db, {
      roomId: input.roomId,
      taskId: input.taskId,
      messageId: input.messageId,
      runId: input.runId,
      agentId: input.agentId,
      kind: note.kind,
      status: note.status,
      confidence: note.confidence,
      title: note.title,
      target: note.target,
      body: note.body,
      evidence: note.evidence,
    });
    input.onCollaborationItemCreated?.(item);
    input.recordRunAction({
      roomId: input.roomId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'completed',
      label: `recorded ${note.kind}`,
      detail: note.title,
    });
  }
}
