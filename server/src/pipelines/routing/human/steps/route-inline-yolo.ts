import type { PipelineStep } from '../../../core/pipeline.js';
import { makeHumanRoutingDecision } from '../predicates/make-human-routing-decision.js';
import { yoloSubset } from '../predicates/yolo-subset.js';
import type { HumanRoutingPipelineContext } from '../types.js';

export const routeInlineYoloStep: PipelineStep<HumanRoutingPipelineContext> = {
  name: 'routing.human.inline-yolo',
  run(context) {
    if (context.decision || !context.inlineYoloProfile) return context;
    const trace = [
      ...context.trace,
      {
        id: 'inline-yolo',
        result: 'matched' as const,
        reason: 'message requested YOLO/autopilot mode explicitly',
        agents: context.roomResponders,
      },
    ];
    return {
      ...context,
      trace,
      decision: makeHumanRoutingDecision({
        action: 'start-yolo',
        reason: 'inline-yolo-request',
        responders: context.roomResponders,
        yoloResponders: yoloSubset(context.room, context.roomResponders),
        references: context.references,
        trace,
      }),
    };
  },
};
