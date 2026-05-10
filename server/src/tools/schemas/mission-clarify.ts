// server/src/tools/schemas/mission-clarify.ts
//
// Schemas for `mission.clarify.ask` (lead asks a question) and
// `mission.clarify.answer` (designated agent answers — humans answer via the
// HTTP route, not via MCP). Both schemas mirror the alias-tolerant style of
// `mission.receipt.submit` so callers can use either snake_case or camelCase.

import type { ClarifyingQuestionCategory } from '../../repos/clarifying-questions.js';

const CATEGORIES: ReadonlySet<ClarifyingQuestionCategory> = new Set<ClarifyingQuestionCategory>([
  'scope',
  'data-model',
  'acceptance',
  'out-of-scope',
  'risk',
  'general',
]);

const CATEGORY_ALIASES = new Map<string, ClarifyingQuestionCategory>([
  ['scope', 'scope'],
  ['data-model', 'data-model'],
  ['data_model', 'data-model'],
  ['datamodel', 'data-model'],
  ['acceptance', 'acceptance'],
  ['ac', 'acceptance'],
  ['out-of-scope', 'out-of-scope'],
  ['out_of_scope', 'out-of-scope'],
  ['outofscope', 'out-of-scope'],
  ['risk', 'risk'],
  ['general', 'general'],
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function requireString(input: UnknownRecord, label: string, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  throw new Error(`${label} is required`);
}

function parseCategory(value: unknown): ClarifyingQuestionCategory {
  if (typeof value !== 'string' || !value.trim()) return 'general';
  const normalized = value.trim().toLowerCase();
  if (CATEGORIES.has(normalized as ClarifyingQuestionCategory)) {
    return normalized as ClarifyingQuestionCategory;
  }
  const aliased = CATEGORY_ALIASES.get(normalized);
  if (aliased) return aliased;
  throw new Error(`category must be one of: ${Array.from(CATEGORIES).join(', ')}`);
}

export interface MissionClarifyAskArgs {
  question: string;
  category: ClarifyingQuestionCategory;
}

export const missionClarifyAskSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['question'],
    properties: {
      question: {
        type: 'string',
        description: 'The clarifying question to ask. Must be non-empty.',
      },
      category: {
        type: 'string',
        enum: ['scope', 'data-model', 'acceptance', 'out-of-scope', 'risk', 'general'],
        description: 'Topic family. Defaults to "general". Aliases (data_model, ac, ...) accepted.',
      },
    },
  },
  parse(input: unknown): MissionClarifyAskArgs {
    if (!isRecord(input)) throw new Error('mission.clarify.ask args must be an object');
    const question = requireString(input, 'question', 'question', 'q', 'text');
    const category = parseCategory(input.category);
    return { question, category };
  },
};

export interface MissionClarifyAnswerArgs {
  questionId: string;
  answer: string;
}

export const missionClarifyAnswerSchema = {
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['questionId', 'answer'],
    properties: {
      questionId: {
        type: 'string',
        description: 'The clarifying-question id returned by mission.clarify.ask.',
      },
      answer: {
        type: 'string',
        description: 'The answer text. Must be non-empty.',
      },
    },
  },
  parse(input: unknown): MissionClarifyAnswerArgs {
    if (!isRecord(input)) throw new Error('mission.clarify.answer args must be an object');
    const questionId = requireString(input, 'questionId', 'questionId', 'question_id', 'id');
    const answer = requireString(input, 'answer', 'answer', 'reply', 'response');
    return { questionId, answer };
  },
};
