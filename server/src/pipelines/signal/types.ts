import type { YoloPermissionProfile } from '../../permissions.js';
import type { Room } from '../../repos/rooms.js';
import type {
  RoomAgentReferenceResult,
  RoutingRuleTrace,
} from '../../routing/agent-references.js';

export interface MessageSignalPipelineInput {
  room: Room;
  authorId: string;
  text: string;
  inlineYoloProfile?: YoloPermissionProfile | undefined;
}

export interface MessageSignalFlags {
  hasAgentReferences: boolean;
  hasAmbiguousAgentReferences: boolean;
  hasInlineYoloIntent: boolean;
}

export interface MessageSignalPipelineContext {
  room: Room;
  authorId: string;
  text: string;
  providedInlineYoloProfile: YoloPermissionProfile | null;
  references: RoomAgentReferenceResult;
  inlineYoloProfile: YoloPermissionProfile | null;
  signals: MessageSignalFlags;
  trace: RoutingRuleTrace[];
}
