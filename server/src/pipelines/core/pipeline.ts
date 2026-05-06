export interface PipelineStep<TContext> {
  readonly name: string;
  run(context: TContext): TContext;
}

export function runPipeline<TContext>(
  initialContext: TContext,
  steps: readonly PipelineStep<TContext>[],
): TContext {
  return steps.reduce((context, step) => step.run(context), initialContext);
}
