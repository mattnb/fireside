import { describe, expect, it } from 'vitest';
import type { Room } from '../../src/repos/rooms.js';
import { resolveRoomAgentReferences } from '../../src/routing/agent-references.js';
import { routeAgentMessage } from '../../src/routing/agent-message-router.js';
import { routeHumanMessage } from '../../src/routing/human-message-router.js';

function slateRoom(overrides: Partial<Room> = {}): Room {
  const room: Room = {
    id: 'room',
    projectId: 'project',
    name: 'slate',
    agents: [
      'codex-project-manager',
      'claude-technical-lead',
      'claude-engineering-manager',
    ],
    yoloAgents: [
      'codex-project-manager',
      'claude-technical-lead',
      'claude-engineering-manager',
    ],
    leadAgentId: null,
    agentProfiles: [
      {
        id: 'codex-project-manager',
        providerId: 'codex',
        displayName: 'Jimmy',
        personaId: 'project-manager',
        personaName: 'Project Manager',
        personaSummary: '',
      },
      {
        id: 'claude-technical-lead',
        providerId: 'claude',
        displayName: 'Sean',
        personaId: 'technical-lead',
        personaName: 'Technical Lead',
        personaSummary: '',
      },
      {
        id: 'claude-engineering-manager',
        providerId: 'claude',
        displayName: 'Alexander',
        personaId: 'engineering-manager',
        personaName: 'Engineering Manager',
        personaSummary: '',
      },
    ],
    createdAt: 1,
  };
  return { ...room, ...overrides };
}

function route(input: {
  text: string;
  room?: Room;
  roomHasActiveWork?: boolean;
  activeYolo?: boolean;
  busyAgents?: string[];
}) {
  return routeHumanMessage({
    room: input.room ?? slateRoom(),
    authorId: 'matt',
    text: input.text,
    roomHasActiveWork: input.roomHasActiveWork ?? false,
    activeYolo: input.activeYolo ?? false,
    busyAgents: new Set(input.busyAgents ?? []),
  });
}

describe('resolveRoomAgentReferences', () => {
  it('keeps unambiguous room-local handoffs even when a provider alias is ambiguous', () => {
    const result = resolveRoomAgentReferences(
      slateRoom(),
      'Sean, please take the sequencing brief. Claude can review later.',
    );

    expect(result.agentIds).toContain('claude-technical-lead');
    expect(result.ambiguousAliases).toContain('claude');
  });
});

describe('routeHumanMessage', () => {
  it('routes explicit @display-name messages directly even when the target is a YOLO participant', () => {
    const decision = route({ text: '@jimmy accept defaults' });

    expect(decision).toMatchObject({
      action: 'direct-agent-turn',
      reason: 'explicit-human-mention',
      responders: ['codex-project-manager'],
      bypassRoomYolo: true,
    });
  });

  it('starts room YOLO only for unaddressed messages with YOLO participants', () => {
    const decision = route({ text: 'team keep going' });

    expect(decision).toMatchObject({
      action: 'start-yolo',
      reason: 'room-yolo-unaddressed-message',
      yoloResponders: [
        'codex-project-manager',
        'claude-technical-lead',
        'claude-engineering-manager',
      ],
    });
  });

  it('routes explicit mentions to free targets while other work is active', () => {
    const decision = route({
      text: '@jimmy can you answer this?',
      roomHasActiveWork: true,
      busyAgents: ['claude-technical-lead'],
    });

    expect(decision).toMatchObject({
      action: 'direct-agent-turn',
      reason: 'explicit-human-mention-to-free-agent-while-active',
      responders: ['codex-project-manager'],
    });
  });

  it('queues explicit mentions when every target is busy', () => {
    const decision = route({
      text: '@jimmy can you answer this?',
      roomHasActiveWork: true,
      busyAgents: ['codex-project-manager'],
    });

    expect(decision).toMatchObject({
      action: 'queue-human-message',
      reason: 'target-agents-busy',
      responders: ['codex-project-manager'],
    });
  });

  it('blocks fully ambiguous provider mentions instead of fanning out accidentally', () => {
    const decision = route({ text: '@claude can one of you take this?' });

    expect(decision).toMatchObject({
      action: 'append-only',
      reason: 'ambiguous-agent-reference',
    });
    expect(decision.references.ambiguousAliases).toContain('claude');
  });

  it('uses unambiguous exact targets despite unrelated ambiguous aliases', () => {
    const decision = route({
      text: 'Sean, please take the sequencing brief. Claude can review later.',
    });

    expect(decision).toMatchObject({
      action: 'direct-agent-turn',
      reason: 'explicit-human-mention',
      responders: ['claude-technical-lead'],
    });
    expect(decision.references.ambiguousAliases).toContain('claude');
  });

  it('fans out to room discussion when no YOLO participants are configured', () => {
    const room = slateRoom({ yoloAgents: [] });
    const decision = route({ room, text: 'team review this' });

    expect(decision).toMatchObject({
      action: 'group-discussion',
      reason: 'room-discussion-unaddressed-message',
      responders: [
        'codex-project-manager',
        'claude-technical-lead',
        'claude-engineering-manager',
      ],
    });
  });
});

describe('routeAgentMessage', () => {
  it('hands off to an unambiguous room-local target despite unrelated ambiguous aliases', () => {
    const decision = routeAgentMessage({
      room: slateRoom(),
      authorId: 'codex-project-manager',
      text: [
        'Defaults accepted. Sean should draft the technical sequencing brief.',
        'Claude can review the plan later if needed.',
      ].join(' '),
    });

    expect(decision).toMatchObject({
      action: 'agent-handoff',
      reason: 'agent-mentioned-room-participant',
      responders: ['claude-technical-lead'],
    });
    expect(decision.references.ambiguousAliases).toContain('claude');
  });

  it('does not hand off a fully ambiguous provider alias', () => {
    const decision = routeAgentMessage({
      room: slateRoom(),
      authorId: 'codex-project-manager',
      text: 'Claude should take the next task.',
    });

    expect(decision).toMatchObject({
      action: 'no-handoff',
      reason: 'ambiguous-agent-reference',
      responders: [],
    });
  });

  it('respects a YOLO handoff pool when one is supplied', () => {
    const decision = routeAgentMessage({
      room: slateRoom(),
      authorId: 'codex-project-manager',
      text: 'Sean should draft the technical sequencing brief.',
      allowedAgents: new Set(['claude-engineering-manager']),
    });

    expect(decision).toMatchObject({
      action: 'no-handoff',
      reason: 'no-agent-reference',
      responders: [],
    });
    expect(decision.references.agentIds).toEqual(['claude-technical-lead']);
  });
});
