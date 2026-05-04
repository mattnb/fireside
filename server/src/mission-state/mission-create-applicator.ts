import type { AgentId } from '../agents/types.js';
import type { ParsedMissionCreateUpdate } from '../mission-create-updates.js';
import type { CreateAgentRunActionInput } from '../repos/run-actions.js';
import type { CreateTaskInput, Task } from '../repos/tasks.js';

export interface ApplyMissionCreateUpdatesInput {
  roomId: string;
  activeTask: Task | null;
  runId: string;
  agentId: AgentId;
  updates: ParsedMissionCreateUpdate[];
  createTask: (roomId: string, input: Omit<CreateTaskInput, 'roomId'>) => Task | null;
  recordRunAction: (input: CreateAgentRunActionInput) => void;
}

export function applyMissionCreateUpdates(input: ApplyMissionCreateUpdatesInput): Task | null {
  if (input.updates.length === 0) return null;
  if (input.activeTask) {
    input.recordRunAction({
      roomId: input.roomId,
      taskId: input.activeTask.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'diagnostic',
      status: 'failed',
      label: 'mission create ignored',
      detail: `active mission already exists: ${input.activeTask.title}`,
    });
    return null;
  }

  let created: Task | null = null;
  for (const update of input.updates) {
    if (created) {
      input.recordRunAction({
        roomId: input.roomId,
        taskId: created.id,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission create ignored',
        detail: `mission already created this turn: ${created.title}`,
      });
      continue;
    }

    created = input.createTask(input.roomId, {
      title: update.title.slice(0, 200),
      goal: update.goal.slice(0, 4000),
      repoPath: update.repoPath.slice(0, 2000),
      acceptanceCriteria: update.acceptanceCriteria.slice(0, 4000),
      ...(update.agents ? { agents: update.agents } : {}),
      ...(update.capabilityProfile ? { capabilityProfile: update.capabilityProfile } : {}),
      summary: update.summary.slice(0, 2000),
    });

    if (!created) {
      input.recordRunAction({
        roomId: input.roomId,
        taskId: null,
        runId: input.runId,
        agentId: input.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission create ignored',
        detail: update.title,
      });
      continue;
    }

    input.recordRunAction({
      roomId: input.roomId,
      taskId: created.id,
      runId: input.runId,
      agentId: input.agentId,
      kind: 'ledger',
      status: 'completed',
      label: 'mission created',
      detail: `${created.title} (${created.capabilityProfile})`,
    });
  }

  return created;
}
