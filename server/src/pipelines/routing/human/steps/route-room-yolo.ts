import type { PipelineStep } from '../../../core/pipeline.js';
import { makeHumanRoutingDecision } from '../predicates/make-human-routing-decision.js';
import { yoloSubset } from '../predicates/yolo-subset.js';
import type { HumanRoutingPipelineContext } from '../types.js';

export const routeRoomYoloStep: PipelineStep<HumanRoutingPipelineContext> = {
  name: 'routing.human.room-yolo',
  run(context) {
    if (context.decision) return context;
    const yoloResponders = yoloSubset(context.room, context.roomResponders);
    if (yoloResponders.length === 0) return context;
    const trace = [
      ...context.trace,
      {
        id: 'room-yolo',
        result: 'matched' as const,
        reason: 'unaddressed message can be handled by room YOLO participants',
        agents: yoloResponders,
      },
    ];
    return {
      ...context,
      trace,
      decision: makeHumanRoutingDecision({
        action: 'start-yolo',
        reason: 'room-yolo-unaddressed-message',
        responders: context.roomResponders,
        yoloResponders,
        references: context.references,
        trace,
      }),
    };
  },
};
