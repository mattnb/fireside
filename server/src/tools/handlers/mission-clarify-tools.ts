// server/src/tools/handlers/mission-clarify-tools.ts
//
// Pure CRUD handlers for the clarify tools. State-machine transitions
// (e.g. bumping draft → elaborating on the first ask) are deferred to PR 2
// where the gate-side logic lives.

import { getActiveTask, getTask } from '../../repos/tasks.js';
import {
  answerQuestion,
  createClarifyingQuestion,
  getClarifyingQuestion,
} from '../../repos/clarifying-questions.js';
import { defineTool } from '../registry.js';
import {
  missionClarifyAnswerSchema,
  missionClarifyAskSchema,
  type MissionClarifyAnswerArgs,
  type MissionClarifyAskArgs,
} from '../schemas/mission-clarify.js';
import type { AgentToolHandlerInput, AgentToolResult } from '../types.js';

export function handleMissionClarifyAsk(
  input: AgentToolHandlerInput<MissionClarifyAskArgs>,
): AgentToolResult {
  const mission = input.call.missionId
    ? getTask(input.db, input.call.missionId)
    : getActiveTask(input.db, input.call.roomId);

  if (!mission) {
    return {
      status: 'rejected',
      summary: 'mission.clarify.ask rejected: no active mission',
      effects: [],
    };
  }

  const question = createClarifyingQuestion(input.db, {
    taskId: mission.id,
    askedByAgentId: input.call.agentId,
    question: input.args.question,
    category: input.args.category,
  });

  return {
    status: 'applied',
    summary: `mission.clarify.ask: ${question.id}`,
    data: {
      questionId: question.id,
      taskId: question.taskId,
      category: question.category,
      question: question.question,
    },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task',
        targetId: mission.id,
        summary: `Lead asked a clarifying question (${question.category}).`,
        payload: { questionId: question.id },
      },
    ],
  };
}

export function handleMissionClarifyAnswer(
  input: AgentToolHandlerInput<MissionClarifyAnswerArgs>,
): AgentToolResult {
  const existing = getClarifyingQuestion(input.db, input.args.questionId);
  if (!existing) {
    return {
      status: 'rejected',
      summary: `mission.clarify.answer rejected: unknown question ${input.args.questionId}`,
      effects: [],
    };
  }

  const updated = answerQuestion(input.db, input.args.questionId, {
    answer: input.args.answer,
    answeredBy: input.call.agentId,
  });

  return {
    status: 'applied',
    summary: `mission.clarify.answer: ${input.args.questionId}`,
    data: {
      questionId: updated?.id,
      taskId: updated?.taskId,
      answeredBy: updated?.answeredBy,
      answeredAt: updated?.answeredAt,
    },
    effects: [
      {
        kind: 'task-updated',
        targetType: 'task',
        targetId: existing.taskId,
        summary: `Clarifying question answered by ${input.call.agentId}.`,
        payload: { questionId: existing.id },
      },
    ],
  };
}

export const missionClarifyAskTool = defineTool<MissionClarifyAskArgs>({
  name: 'mission.clarify.ask',
  summary:
    'Lead asks a clarifying question against the active mission. Persists the question for later answer.',
  requiredPermissions: ['mission:write'],
  schema: missionClarifyAskSchema,
  handler: handleMissionClarifyAsk,
});

export const missionClarifyAnswerTool = defineTool<MissionClarifyAnswerArgs>({
  name: 'mission.clarify.answer',
  summary:
    'Designated answerer answers a previously-asked clarifying question. Humans answer via HTTP, not MCP.',
  requiredPermissions: ['mission:write'],
  schema: missionClarifyAnswerSchema,
  handler: handleMissionClarifyAnswer,
});

export const missionClarifyTools = [missionClarifyAskTool, missionClarifyAnswerTool] as const;
