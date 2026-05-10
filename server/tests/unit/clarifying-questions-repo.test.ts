// server/tests/unit/clarifying-questions-repo.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom, deleteRoom } from '../../src/repos/rooms.js';
import { createTask } from '../../src/repos/tasks.js';
import {
  createClarifyingQuestion,
  listClarifyingQuestions,
  openQuestions,
  answerQuestion,
  type ClarifyingQuestionCategory,
} from '../../src/repos/clarifying-questions.js';

describe('clarifying-questions repo', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;
  let taskId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'r', agents: ['claude', 'codex'] }).id;
    taskId = createTask(db, { roomId, title: 't', proposalStatus: 'elaborating' }).id;
  });

  it('creates a question with sensible defaults', () => {
    const q = createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'should this be one PR or two?',
    });
    expect(q.taskId).toBe(taskId);
    expect(q.askedByAgentId).toBe('claude');
    expect(q.question).toBe('should this be one PR or two?');
    expect(q.category).toBe('general');
    expect(q.answer).toBe('');
    expect(q.answeredBy).toBe('');
    expect(q.answeredAt).toBeNull();
    expect(q.sortOrder).toBe(0);
  });

  it('honours an explicit category and sortOrder', () => {
    const q = createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'what is the data model?',
      category: 'data-model',
      sortOrder: 3,
    });
    expect(q.category).toBe('data-model');
    expect(q.sortOrder).toBe(3);
  });

  it('every documented category is accepted', () => {
    const cats: ClarifyingQuestionCategory[] = [
      'scope',
      'data-model',
      'acceptance',
      'out-of-scope',
      'risk',
      'general',
    ];
    for (const category of cats) {
      const q = createClarifyingQuestion(db, {
        taskId,
        askedByAgentId: 'claude',
        question: `q for ${category}`,
        category,
      });
      expect(q.category).toBe(category);
    }
  });

  it('listClarifyingQuestions returns rows ordered by sort_order', () => {
    createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'b',
      sortOrder: 2,
    });
    createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'a',
      sortOrder: 1,
    });
    createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'c',
      sortOrder: 3,
    });
    const list = listClarifyingQuestions(db, taskId);
    expect(list.map((q) => q.question)).toEqual(['a', 'b', 'c']);
  });

  it('openQuestions returns only rows with empty answers', () => {
    const a = createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'first',
    });
    const b = createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'second',
    });
    answerQuestion(db, a.id, { answer: 'because reasons', answeredBy: 'human' });

    const open = openQuestions(db, taskId);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(b.id);
  });

  it('answerQuestion stamps answer, answeredBy, and answeredAt', () => {
    const q = createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'why?',
    });
    const before = Date.now();
    const answered = answerQuestion(db, q.id, { answer: 'because', answeredBy: 'human' });
    expect(answered?.answer).toBe('because');
    expect(answered?.answeredBy).toBe('human');
    expect(answered?.answeredAt).toBeGreaterThanOrEqual(before);
  });

  it('answerQuestion rejects empty answers', () => {
    const q = createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'why?',
    });
    expect(() => answerQuestion(db, q.id, { answer: '', answeredBy: 'human' })).toThrow(
      /non-empty/i,
    );
    expect(() => answerQuestion(db, q.id, { answer: '   ', answeredBy: 'human' })).toThrow(
      /non-empty/i,
    );
  });

  it('answerQuestion returns null for an unknown id', () => {
    expect(answerQuestion(db, 'nope', { answer: 'x', answeredBy: 'human' })).toBeNull();
  });

  it('ON DELETE CASCADE removes questions when the task is deleted', () => {
    createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'a',
    });
    createClarifyingQuestion(db, {
      taskId,
      askedByAgentId: 'claude',
      question: 'b',
    });
    expect(listClarifyingQuestions(db, taskId)).toHaveLength(2);
    deleteRoom(db, roomId);
    expect(listClarifyingQuestions(db, taskId)).toHaveLength(0);
  });
});
