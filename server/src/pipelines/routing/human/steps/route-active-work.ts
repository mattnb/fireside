import type { PipelineStep } from '../../../core/pipeline.js';
import { isRoomActive } from '../predicates/is-room-active.js';
import { makeHumanRoutingDecision } from '../predicates/make-human-routing-decision.js';
import type { HumanRoutingPipelineContext } from '../types.js';

export const routeActiveWorkStep: PipelineStep<HumanRoutingPipelineContext> = {
  name: 'routing.human.active-work',
  run(context) {
    if (context.decision || !isRoomActive(context)) return context;

    const trace = [
      ...context.trace,
      {
        id: 'active-work',
        result: 'matched' as const,
        reason: context.activeYolo
          ? 'room has an active YOLO discussion'
          : 'room has active provider work',
      },
    ];

    if (context.targetedResponders.length > 0) {
      const freeResponders = context.targetedResponders.filter(
        (agent) => !context.busyAgents.has(agent),
      );
      if (freeResponders.length > 0) {
        const freeTrace = [
          ...trace,
          {
            id: 'targeted-busy-check',
            result: 'matched' as const,
            reason: 'at least one explicitly targeted agent is free',
            agents: freeResponders,
          },
        ];
        return {
          ...context,
          trace: freeTrace,
          decision: makeHumanRoutingDecision({
            action: 'direct-agent-turn',
            reason: 'explicit-human-mention-to-free-agent-while-active',
            responders: freeResponders,
            bypassRoomYolo: true,
            references: context.references,
            trace: freeTrace,
          }),
        };
      }
      trace.push({
        id: 'targeted-busy-check',
        result: 'blocked',
        reason: 'all explicitly targeted agents are busy',
        agents: context.targetedResponders,
      });
    }

    return {
      ...context,
      trace,
      decision: makeHumanRoutingDecision({
        action: 'queue-human-message',
        reason:
          context.targetedResponders.length > 0
            ? 'target-agents-busy'
            : 'room-active-without-free-target',
        responders: context.targetedResponders,
        references: context.references,
        trace,
      }),
    };
  },
};
