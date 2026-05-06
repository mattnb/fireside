import type { AgentId } from '../../../agents/types.js';
import type { YoloPermissionProfile } from '../../../permissions.js';
import type { Room } from '../../../repos/rooms.js';
import type {
  RoomAgentReferenceResult,
  RoutingRuleTrace,
} from '../../../routing/agent-references.js';
import type { MessageSignalPipelineContext } from '../../signal/types.js';

export type HumanRoutingAction =
  | 'direct-agent-turn'
  | 'group-discussion'
  | 'start-yolo'
  | 'queue-human-message'
  | 'append-only';

export interface HumanRoutingDecision {
  action: HumanRoutingAction;
  reason: string;
  responders: AgentId[];
  yoloResponders: AgentId[];
  bypassRoomYolo: boolean;
  references: RoomAgentReferenceResult;
  trace: RoutingRuleTrace[];
}

export interface RouteHumanMessageInput {
  room: Room;
  authorId: string;
  text: string;
  roomHasActiveWork: boolean;
  activeYolo: boolean;
  busyAgents: Set<AgentId>;
  inlineYoloProfile?: YoloPermissionProfile | undefined;
}

export interface HumanRoutingPipelineContext extends MessageSignalPipelineContext {
  roomHasActiveWork: boolean;
  activeYolo: boolean;
  busyAgents: Set<AgentId>;
  targetedResponders: AgentId[];
  roomResponders: AgentId[];
  decision: HumanRoutingDecision | null;
}
