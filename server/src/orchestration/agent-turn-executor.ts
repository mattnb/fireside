import type {
  AgentReply,
  AgentModelSettings,
  AgentSpec,
  AgentStreamEvent,
  AgentTurnKind,
} from '../agents/types.js';
import type { PermissionGrant } from '../permissions.js';
import { decideRunRetry, type RunRetryDecision } from '../run-lifecycle.js';

export interface ProviderTurnRunAgent {
  (
    spec: AgentSpec,
    prompt: string,
    sessionId: string | null,
    permission?: PermissionGrant,
    cancelSignal?: AbortSignal,
    onStreamEvent?: (event: AgentStreamEvent) => void,
    timeoutMs?: number | null,
    turnKind?: AgentTurnKind,
    modelSettings?: AgentModelSettings,
    roomId?: string,
  ): Promise<AgentReply>;
}

export type ProviderTurnFailure = {
  ok: false;
  error: string;
  stdout: string;
  stderr: string;
  canceled: boolean;
  retryDecision: RunRetryDecision | null;
};

export type ProviderTurnExecutionResult =
  | { ok: true; reply: AgentReply }
  | ProviderTurnFailure;

export interface ExecuteProviderTurnInput {
  runAgent: ProviderTurnRunAgent;
  spec: AgentSpec;
  prompt: string;
  sessionId: string | null;
  permission?: PermissionGrant;
  cancelSignal?: AbortSignal;
  onStreamEvent?: (event: AgentStreamEvent) => void;
  registerAbortController: (controller: AbortController) => void;
  unregisterAbortController: () => void;
  startHeartbeat: () => () => void;
  yoloMode: boolean;
  attempt: number;
  maxRetryAttempts?: number;
  turnKind?: AgentTurnKind;
  modelSettings?: AgentModelSettings;
  roomId?: string;
}

export async function executeProviderTurn(
  input: ExecuteProviderTurnInput,
): Promise<ProviderTurnExecutionResult> {
  const stopHeartbeat = input.startHeartbeat();
  const runAbortController = new AbortController();
  const relayCancel = (): void => runAbortController.abort();
  if (input.cancelSignal?.aborted) {
    runAbortController.abort();
  } else {
    input.cancelSignal?.addEventListener('abort', relayCancel, { once: true });
  }
  input.registerAbortController(runAbortController);

  try {
    const reply = await input.runAgent(
      input.spec,
      input.prompt,
      input.sessionId,
      input.permission,
      runAbortController.signal,
      input.onStreamEvent,
      input.permission?.source === 'yolo' ? null : undefined,
      input.turnKind,
      input.modelSettings,
      input.roomId,
    );
    return { ok: true, reply };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const raw = rawOutputFromError(err);
    const canceled =
      input.cancelSignal?.aborted ||
      runAbortController.signal.aborted ||
      (err instanceof Error && err.name === 'SubprocessCanceledError');
    return {
      ok: false,
      error,
      stdout: raw.stdout,
      stderr: raw.stderr,
      canceled,
      retryDecision:
        !canceled && input.yoloMode
          ? decideRunRetry(
              { state: 'failed', attempt: input.attempt },
              { maxAttempts: input.maxRetryAttempts ?? 3 },
            )
          : null,
    };
  } finally {
    input.unregisterAbortController();
    input.cancelSignal?.removeEventListener('abort', relayCancel);
    stopHeartbeat();
  }
}

export function rawOutputFromError(err: unknown): { stdout: string; stderr: string } {
  if (!err || typeof err !== 'object') return { stdout: '', stderr: '' };
  const obj = err as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof obj.stdout === 'string' ? obj.stdout : '',
    stderr: typeof obj.stderr === 'string' ? obj.stderr : '',
  };
}

export function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return Promise.resolve(signal?.aborted !== true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
