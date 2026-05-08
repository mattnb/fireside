// server/src/tools/adapters/slash-block-adapter.ts
//
// Canonical text-input adapter for the structured agent tool layer. Translates
// `/mission-*`, `/permission-request`, and `/collab-note` hidden slash blocks
// into structured `AgentToolCall` shapes and runs them through
// `executeToolCall`, alongside native provider tool calls and the MCP adapter.
// The broker keeps owning prompt extraction; this layer owns the conversion
// and the per-update orchestration so audit rows, idempotency, and effects
// all flow through the tool engine.
//
// Scope: action='update' and action='note' route through the tool engine.
// action='create' falls back to `applyMissionTaskUpdates` directly because no
// `mission.task.create` tool exists yet; an audit row is still written so the
// phase gate's "every block produces a row" requirement holds.

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { applyMissionTaskUpdates } from '../../mission-state/mission-task-applicator.js';
import type { MissionTaskApplyResult } from '../../mission-state/mission-task-applicator.js';
import type { ParsedMissionTaskUpdate } from '../../mission-task-updates.js';
import type { ParsedMissionPhaseUpdate } from '../../mission-phase-updates.js';
import type { ParsedMissionPlanUpdate } from '../../mission-plan-updates.js';
import type { ParsedCollaborationNote } from '../../collaboration-notes.js';
import type { ParsedMissionReceipt } from '../../mission-receipts.js';
import type {
  ParsedPermissionRequest,
  PermissionGrant,
  PermissionRequest,
} from '../../permissions.js';
import type { CreateAgentRunActionInput } from '../../repos/run-actions.js';
import type { CollaborationItem } from '../../repos/collaboration.js';
import type { WorkLaneAssignment } from '../../orchestration/work-lane-planner.js';
import { addPermissionRequest, listPermissionRequests } from '../../repos/permission-requests.js';
import { getTask, type Task } from '../../repos/tasks.js';
import { listTaskPhases, type TaskPhase } from '../../repos/task-phases.js';
import { listTaskPlans, type TaskPlan } from '../../repos/task-plans.js';
import { recordCall } from '../idempotency.js';
import { executeToolCall } from '../execute-tool-call.js';
import { collabNoteAddTool, collabNoteUpdateTool } from '../handlers/collab-tools.js';
import { missionPhaseTools } from '../handlers/mission-phase-tools.js';
import { missionPlanTools } from '../handlers/mission-plan-tools.js';
import { missionReceiptSubmitTool } from '../handlers/mission-receipt-tools.js';
import { missionTaskAddNoteTool, missionTaskUpdateTool } from '../handlers/mission-task-tools.js';
import { permissionRequestTool } from '../handlers/permission-tools.js';
import { defaultToolRegistry } from '../registry.js';
import type { CollabNoteAddArgs } from '../schemas/collab.js';
import type { AgentToolDefinition, ExecuteToolCallOutcome } from '../types.js';

let toolsRegistered = false;

/**
 * Idempotently register the mission-task and collab tools with the default
 * registry. Safe to call multiple times across reloads or dev-server restarts.
 */
export function ensureMissionTaskToolsRegistered(): void {
  if (toolsRegistered) return;
  if (!defaultToolRegistry.has(missionTaskUpdateTool.name)) {
    defaultToolRegistry.register(missionTaskUpdateTool);
  }
  if (!defaultToolRegistry.has(missionTaskAddNoteTool.name)) {
    defaultToolRegistry.register(missionTaskAddNoteTool);
  }
  if (!defaultToolRegistry.has(collabNoteAddTool.name)) {
    defaultToolRegistry.register(collabNoteAddTool);
  }
  if (!defaultToolRegistry.has(collabNoteUpdateTool.name)) {
    defaultToolRegistry.register(collabNoteUpdateTool);
  }
  toolsRegistered = true;
}

export function ensureMissionPlanPhaseToolsRegistered(): void {
  registerDefaultToolIfMissing(missionPlanTools[0]);
  registerDefaultToolIfMissing(missionPlanTools[1]);
  registerDefaultToolIfMissing(missionPlanTools[2]);
  registerDefaultToolIfMissing(missionPlanTools[3]);
  registerDefaultToolIfMissing(missionPhaseTools[0]);
  registerDefaultToolIfMissing(missionPhaseTools[1]);
  registerDefaultToolIfMissing(missionPhaseTools[2]);
  registerDefaultToolIfMissing(missionPhaseTools[3]);
}

function registerDefaultToolIfMissing<TArgs>(tool: AgentToolDefinition<TArgs>): void {
  if (!defaultToolRegistry.has(tool.name)) {
    defaultToolRegistry.register(tool);
  }
}

export function ensurePermissionToolsRegistered(): void {
  if (!defaultToolRegistry.has(permissionRequestTool.name)) {
    defaultToolRegistry.register(permissionRequestTool);
  }
}

export function ensureMissionReceiptToolsRegistered(): void {
  if (!defaultToolRegistry.has(missionReceiptSubmitTool.name)) {
    defaultToolRegistry.register(missionReceiptSubmitTool);
  }
}

export interface MissionTaskRoutingContext {
  db: Database;
  roomId: string;
  mission: Task | null;
  runId: string;
  messageId?: string | null;
  agentId: string;
  permission?: PermissionGrant | null;
  defaultPlanId: string | null;
  forcePlanOnUpdates: boolean;
  recordRunAction: (input: CreateAgentRunActionInput) => void;
  onTaskUpdated?: (task: Task) => void;
}

export interface MissionTaskRoutingOutcome {
  result: MissionTaskApplyResult;
  toolCalls: ExecuteToolCallOutcome[];
}

export interface MissionPlanRoutingContext {
  db: Database;
  roomId: string;
  mission: Task | null;
  runId: string;
  messageId?: string | null;
  agentId: string;
  permission?: PermissionGrant | null;
  onTaskUpdated?: (task: Task) => void;
}

export interface MissionPlanRoutingOutcome {
  activePlan: TaskPlan | null;
  toolCalls: ExecuteToolCallOutcome[];
}

export interface MissionPhaseRoutingContext {
  db: Database;
  roomId: string;
  mission: Task | null;
  runId: string;
  messageId?: string | null;
  agentId: string;
  permission?: PermissionGrant | null;
  defaultPlanId: string | null;
  forcePlanOnUpdates: boolean;
  onTaskUpdated?: (task: Task) => void;
  autoAdvancePhase?: (input: {
    roomId: string;
    task: Task;
    runId: string;
    agentId: string;
    completedPhase: TaskPhase | null;
  }) => void;
}

export interface MissionPhaseRoutingOutcome {
  applied: number;
  toolCalls: ExecuteToolCallOutcome[];
}

export interface PermissionRequestRoutingContext {
  db: Database;
  roomId: string;
  mission: Task | null;
  runId: string;
  messageId?: string | null;
  agentId: string;
  permission?: PermissionGrant | null;
  persistRequest?: boolean;
  now?: () => number;
}

export interface PermissionRequestRoutingOutcome {
  toolCall: ExecuteToolCallOutcome;
  request: PermissionRequest | null;
  parsedRequest: ParsedPermissionRequest | null;
}

export async function routePermissionRequest(
  ctx: PermissionRequestRoutingContext,
  request: ParsedPermissionRequest,
): Promise<PermissionRequestRoutingOutcome> {
  ensurePermissionToolsRegistered();
  const idempotencyKey = createPermissionRequestIdempotencyKey({
    runId: ctx.runId,
    target: request.target,
    reason: request.reason,
  });
  const toolCall = await executeToolCall({
    db: ctx.db,
    call: {
      id: idempotencyKey,
      tool: 'permission.request',
      idempotencyKey,
      args: permissionRequestToArgs(request),
      source: 'hidden-command',
      roomId: ctx.roomId,
      missionId: ctx.mission?.id ?? null,
      runId: ctx.runId,
      messageId: ctx.messageId ?? null,
      agentId: ctx.agentId,
      createdAt: (ctx.now ?? Date.now)(),
    },
    ...(ctx.permission
      ? { permission: ctx.permission }
      : {
          statePermissions: ['permission:request'],
          permissionResolutionSource: 'hidden-command-fallback',
        }),
    ...(ctx.now ? { now: ctx.now } : {}),
  });

  const parsedRequest = parsedPermissionRequestFromOutcome(toolCall);
  const persistedRequest =
    parsedRequest && ctx.persistRequest !== false
      ? addPermissionRequest(ctx.db, {
          roomId: ctx.roomId,
          agentId: ctx.agentId,
          ...parsedRequest,
        })
      : toolCall.status === 'duplicate' && ctx.persistRequest !== false
        ? findMatchingPermissionRequest(ctx, request)
        : null;

  return { toolCall, request: persistedRequest, parsedRequest };
}

function findMatchingPermissionRequest(
  ctx: PermissionRequestRoutingContext,
  request: ParsedPermissionRequest,
): PermissionRequest | null {
  return (
    listPermissionRequests(ctx.db, ctx.roomId).find(
      (candidate) =>
        candidate.agentId === ctx.agentId &&
        candidate.mode === request.mode &&
        candidate.requestedMode === request.requestedMode &&
        candidate.target === request.target &&
        candidate.reason === request.reason,
    ) ?? null
  );
}

/**
 * Run a batch of decoded `/mission-task` blocks through the tool engine,
 * returning the same `MissionTaskApplyResult` shape the broker already
 * consumes (applied/progressed counts plus dispatch candidates).
 */
export async function routeMissionTaskUpdates(
  ctx: MissionTaskRoutingContext,
  updates: ParsedMissionTaskUpdate[],
): Promise<MissionTaskRoutingOutcome> {
  ensureMissionTaskToolsRegistered();
  const aggregate: MissionTaskApplyResult = {
    applied: 0,
    progressed: 0,
    dispatchCandidates: [],
  };
  const toolCalls: ExecuteToolCallOutcome[] = [];

  if (!ctx.mission) {
    // Mirror the direct-applicator diagnostic so existing run-detail surfaces
    // stay accurate. Audit rows aren't possible without a mission (mission_id
    // is required to compose an idempotency key in our schema).
    if (updates.length > 0) {
      ctx.recordRunAction({
        roomId: ctx.roomId,
        taskId: null,
        runId: ctx.runId,
        agentId: ctx.agentId,
        kind: 'diagnostic',
        status: 'failed',
        label: 'mission task update ignored',
        detail: 'no active mission',
      });
    }
    return { result: aggregate, toolCalls };
  }

  for (const update of updates) {
    if (update.action === 'create') {
      // Legacy applicator path. Records its own diagnostic + audit row for
      // continuity with the tool-engine flow.
      const result = applyMissionTaskUpdates({
        db: ctx.db,
        roomId: ctx.roomId,
        task: ctx.mission,
        runId: ctx.runId,
        agentId: ctx.agentId,
        updates: [update],
        defaultPlanId: ctx.defaultPlanId,
        forcePlanOnUpdates: ctx.forcePlanOnUpdates,
        recordRunAction: ctx.recordRunAction,
        ...(ctx.onTaskUpdated ? { onTaskUpdated: ctx.onTaskUpdated } : {}),
      });
      aggregate.applied += result.applied;
      aggregate.progressed += result.progressed;
      aggregate.dispatchCandidates.push(...result.dispatchCandidates);

      const idempotencyKey = createIdempotencyKey({
        runId: ctx.runId,
        tool: 'mission.task.create',
        update,
      });
      const auditRow = recordCall(ctx.db, {
        roomId: ctx.roomId,
        missionId: ctx.mission.id,
        runId: ctx.runId,
        messageId: ctx.messageId ?? null,
        agentId: ctx.agentId,
        toolName: 'mission.task.create',
        idempotencyKey,
        source: 'hidden-command',
        status: result.applied > 0 ? 'applied' : 'rejected',
        args: parsedUpdateToArgs(update),
        normalizedArgs: parsedUpdateToArgs(update),
        result: { applied: result.applied, progressed: result.progressed },
      });
      toolCalls.push({
        callId: auditRow.id,
        toolName: 'mission.task.create',
        status: auditRow.status,
        summary:
          result.applied > 0
            ? `mission.task.create applied (direct path) ${update.title}`
            : `mission.task.create rejected (direct path) ${update.title}`,
      });
      continue;
    }

    const toolName = update.action === 'note' ? 'mission.task.add_note' : 'mission.task.update';
    const args =
      toolName === 'mission.task.add_note'
        ? parsedUpdateToAddNoteArgs(update)
        : parsedUpdateToUpdateArgs(update, ctx);

    const idempotencyKey = createIdempotencyKey({
      runId: ctx.runId,
      tool: toolName,
      update,
    });
    const outcome = await executeToolCall({
      db: ctx.db,
      call: {
        id: idempotencyKey,
        tool: toolName,
        idempotencyKey,
        args,
        source: 'hidden-command',
        roomId: ctx.roomId,
        missionId: ctx.mission.id,
        runId: ctx.runId,
        messageId: ctx.messageId ?? null,
        agentId: ctx.agentId,
        createdAt: Date.now(),
      },
      // When the broker has resolved a permission grant (yolo, task
      // capability profile, workflow profile, or explicit), authorize from
      // it: plan-mode legitimately denies writes; edit/full-auto/yolo pass.
      // When no grant exists (vanilla chat, plan-mode tasks that don't
      // synthesize a grant), fall back to the baseline hidden blocks have
      // always assumed — agents may persist mission/collab turn output.
      // Without this fallback, ungated runs would lose the ability to update
      // mission state, regressing long-standing /mission-task and
      // /collab-note behavior.
      ...(ctx.permission
        ? { permission: ctx.permission }
        : {
            statePermissions: ['mission:write', 'collab:write'],
            permissionResolutionSource: 'hidden-command-fallback',
          }),
    });
    toolCalls.push(outcome);

    if (outcome.status === 'applied') {
      const data = outcome.result?.data as MissionTaskApplyResult | undefined;
      if (data && update.action === 'update') {
        aggregate.applied += data.applied;
        aggregate.progressed += data.progressed;
        aggregate.dispatchCandidates.push(...data.dispatchCandidates);
      } else if (update.action === 'note') {
        aggregate.applied += 1;
      }
      const refreshed = getTask(ctx.db, ctx.mission.id);
      if (refreshed && ctx.onTaskUpdated) ctx.onTaskUpdated(refreshed);
    }
  }

  return { result: aggregate, toolCalls };
}

export async function routeMissionPlanUpdates(
  ctx: MissionPlanRoutingContext,
  updates: ParsedMissionPlanUpdate[],
): Promise<MissionPlanRoutingOutcome> {
  ensureMissionPlanPhaseToolsRegistered();
  const toolCalls: ExecuteToolCallOutcome[] = [];
  let activePlan: TaskPlan | null = null;

  for (const update of updates) {
    for (const callSpec of parsedPlanUpdateToToolCalls(update)) {
      const idempotencyKey = createPlanIdempotencyKey(ctx.runId, callSpec.tool, callSpec.args);
      const outcome = await executeToolCall({
        db: ctx.db,
        call: {
          id: idempotencyKey,
          tool: callSpec.tool,
          idempotencyKey,
          args: callSpec.args,
          source: 'hidden-command',
          roomId: ctx.roomId,
          missionId: ctx.mission?.id ?? null,
          runId: ctx.runId,
          messageId: ctx.messageId ?? null,
          agentId: ctx.agentId,
          createdAt: Date.now(),
        },
        ...(ctx.permission
          ? { permission: ctx.permission }
          : {
              statePermissions: ['mission:write', 'mission:admin'],
              permissionResolutionSource: 'hidden-command-fallback',
            }),
      });
      toolCalls.push(outcome);
      if (outcome.status === 'applied' && ctx.mission) {
        const refreshed = getTask(ctx.db, ctx.mission.id);
        if (refreshed && ctx.onTaskUpdated) ctx.onTaskUpdated(refreshed);
        activePlan =
          listTaskPlans(ctx.db, ctx.mission.id).find((plan) => plan.status === 'active') ?? null;
      }
    }
  }

  return { activePlan, toolCalls };
}

export async function routeMissionPhaseUpdates(
  ctx: MissionPhaseRoutingContext,
  updates: ParsedMissionPhaseUpdate[],
): Promise<MissionPhaseRoutingOutcome> {
  ensureMissionPlanPhaseToolsRegistered();
  const toolCalls: ExecuteToolCallOutcome[] = [];
  let applied = 0;

  for (const update of updates) {
    const callSpec = parsedPhaseUpdateToToolCall(update, ctx);
    const idempotencyKey = createPhaseIdempotencyKey(ctx.runId, callSpec.tool, callSpec.args);
    const outcome = await executeToolCall({
      db: ctx.db,
      call: {
        id: idempotencyKey,
        tool: callSpec.tool,
        idempotencyKey,
        args: callSpec.args,
        source: 'hidden-command',
        roomId: ctx.roomId,
        missionId: ctx.mission?.id ?? null,
        runId: ctx.runId,
        messageId: ctx.messageId ?? null,
        agentId: ctx.agentId,
        createdAt: Date.now(),
      },
      ...(ctx.permission
        ? { permission: ctx.permission }
        : {
            statePermissions: ['mission:write', 'mission:admin'],
            permissionResolutionSource: 'hidden-command-fallback',
          }),
    });
    toolCalls.push(outcome);
    if (outcome.status === 'applied') {
      applied += 1;
      if (ctx.mission) {
        const refreshed = getTask(ctx.db, ctx.mission.id);
        if (refreshed && ctx.onTaskUpdated) ctx.onTaskUpdated(refreshed);
        if (callSpec.tool === 'mission.phase.complete') {
          const completedPhase = completedPhaseFromOutcome(ctx, outcome);
          ctx.autoAdvancePhase?.({
            roomId: ctx.roomId,
            task: ctx.mission,
            runId: ctx.runId,
            agentId: ctx.agentId,
            completedPhase,
          });
        }
      }
    }
  }

  return { applied, toolCalls };
}

export interface MissionReceiptRoutingContext {
  db: Database;
  roomId: string;
  mission: Task | null;
  runId: string;
  messageId?: string | null;
  agentId: string;
  permission?: PermissionGrant | null;
  /** Work-lane assignment from the broker; consumed by this adapter to map a
   * lane shorthand receipt (no itemRef + qualifying status) onto the lane's
   * checklist item before dispatch. The handler never sees this; MCP callers
   * supply itemRef explicitly. */
  workLane?: WorkLaneAssignment | undefined;
}

export interface MissionReceiptRoutingOutcome {
  applied: number;
  progressed: number;
  /** Checklist item IDs the per-receipt apply step touched, used by callers
   * to suppress the work-lane fallback when the lane was already mutated. */
  touchedItemIds: Set<string>;
  toolCalls: ExecuteToolCallOutcome[];
}

/**
 * Route a batch of decoded `/mission-receipt` blocks through the structured
 * tool engine. Each receipt becomes one `mission.receipt.submit` call with a
 * deterministic, content-addressed idempotency key so duplicate-retries
 * collapse without re-running the per-receipt mutation. Cross-cutting
 * reconciliation (work-lane fallback, phase-from-checklist sweep) is
 * intentionally left to `applyReconciliationFallbacks` so this adapter stays
 * focused on the per-receipt path.
 */
export async function routeMissionReceipts(
  ctx: MissionReceiptRoutingContext,
  receipts: ParsedMissionReceipt[],
): Promise<MissionReceiptRoutingOutcome> {
  ensureMissionReceiptToolsRegistered();
  const outcome: MissionReceiptRoutingOutcome = {
    applied: 0,
    progressed: 0,
    touchedItemIds: new Set<string>(),
    toolCalls: [],
  };

  for (const receipt of receipts) {
    const effectiveReceipt = applyWorkLaneShorthand(receipt, ctx.workLane);
    const args = parsedReceiptToArgs(effectiveReceipt);
    const idempotencyKey = createMissionReceiptIdempotencyKey(ctx.runId, effectiveReceipt);
    const result = await executeToolCall({
      db: ctx.db,
      call: {
        id: idempotencyKey,
        tool: 'mission.receipt.submit',
        idempotencyKey,
        args,
        source: 'hidden-command',
        roomId: ctx.roomId,
        missionId: ctx.mission?.id ?? null,
        runId: ctx.runId,
        messageId: ctx.messageId ?? null,
        agentId: ctx.agentId,
        createdAt: Date.now(),
      },
      ...(ctx.permission
        ? { permission: ctx.permission }
        : {
            statePermissions: ['mission:write'],
            permissionResolutionSource: 'hidden-command-fallback',
          }),
    });
    outcome.toolCalls.push(result);

    if (result.status === 'applied') {
      const data = result.result?.data as
        | {
            applied?: number;
            progressed?: number;
            itemTouched?: boolean;
            phaseTouched?: boolean;
            resolvedItemId?: string;
          }
        | undefined;
      if (data) {
        outcome.applied += data.applied ?? 0;
        outcome.progressed += data.progressed ?? 0;
        if (data.itemTouched && data.resolvedItemId) {
          outcome.touchedItemIds.add(data.resolvedItemId);
        }
      }
    }
  }

  return outcome;
}

function applyWorkLaneShorthand(
  receipt: ParsedMissionReceipt,
  workLane: WorkLaneAssignment | undefined,
): ParsedMissionReceipt {
  if (receipt.itemRef || !workLane) return receipt;
  if (receipt.phaseRef || receipt.planRef) return receipt;
  if (
    receipt.status !== 'completed' &&
    receipt.status !== 'blocked' &&
    receipt.status !== 'needs_review' &&
    receipt.status !== 'continuing'
  ) {
    return receipt;
  }
  return { ...receipt, itemRef: workLane.item.id };
}

function parsedReceiptToArgs(receipt: ParsedMissionReceipt): Record<string, unknown> {
  return {
    status: receipt.status,
    ...(receipt.summary ? { summary: receipt.summary } : {}),
    ...(receipt.evidence ? { evidence: receipt.evidence } : {}),
    ...(receipt.next ? { next: receipt.next } : {}),
    ...(receipt.planRef ? { planRef: receipt.planRef } : {}),
    ...(receipt.phaseRef ? { phaseRef: receipt.phaseRef } : {}),
    ...(receipt.itemRef ? { itemRef: receipt.itemRef } : {}),
  };
}

function createMissionReceiptIdempotencyKey(
  runId: string,
  receipt: ParsedMissionReceipt,
): string {
  const target =
    slug(receipt.itemRef) ||
    slug(receipt.phaseRef) ||
    slug(receipt.planRef) ||
    'lane-default';
  const fingerprint = `${receipt.summary}\n${receipt.evidence}\n${receipt.next}`;
  const hash = createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);
  return `${runId}:mission.receipt.submit:${target}:${receipt.status}:${hash}`;
}

export interface CollabNoteRoutingContext {
  db: Database;
  roomId: string;
  taskId: string | null;
  runId: string;
  messageId?: string | null;
  agentId: string;
  permission?: PermissionGrant | null;
  recordRunAction: (input: CreateAgentRunActionInput) => void;
  onCollaborationItemCreated?: (item: CollaborationItem) => void;
}

export interface CollabNoteRoutingOutcome {
  applied: number;
  toolCalls: ExecuteToolCallOutcome[];
}

/**
 * Run a batch of decoded `/collab-note` blocks through the tool engine. The
 * slash-block format has no `id` field, so every block routes to
 * `collab.note.add`; native/MCP callers can still invoke `collab.note.update`
 * through the registry.
 */
export async function routeCollaborationNotes(
  ctx: CollabNoteRoutingContext,
  notes: ParsedCollaborationNote[],
): Promise<CollabNoteRoutingOutcome> {
  ensureMissionTaskToolsRegistered();
  const toolCalls: ExecuteToolCallOutcome[] = [];
  let applied = 0;

  for (const note of notes) {
    const args = parsedNoteToAddArgs(note);
    const idempotencyKey = createCollabNoteIdempotencyKey(ctx.runId, note);
    const outcome = await executeToolCall({
      db: ctx.db,
      call: {
        id: idempotencyKey,
        tool: 'collab.note.add',
        idempotencyKey,
        args: args as unknown as Record<string, unknown>,
        source: 'hidden-command',
        roomId: ctx.roomId,
        missionId: ctx.taskId,
        runId: ctx.runId,
        messageId: ctx.messageId ?? null,
        agentId: ctx.agentId,
        createdAt: Date.now(),
      },
      ...(ctx.permission
        ? { permission: ctx.permission }
        : {
            statePermissions: ['collab:write'],
            permissionResolutionSource: 'hidden-command-fallback',
          }),
    });
    toolCalls.push(outcome);
    if (outcome.status === 'applied') {
      applied += 1;
      const newId = (outcome.result?.data as { id?: string } | undefined)?.id;
      if (newId && ctx.onCollaborationItemCreated) {
        const { getCollaborationItem } = await import('../../repos/collaboration.js');
        const item = getCollaborationItem(ctx.db, newId);
        if (item) ctx.onCollaborationItemCreated(item);
      }
    }
  }

  return { applied, toolCalls };
}

function parsedNoteToAddArgs(note: ParsedCollaborationNote): CollabNoteAddArgs {
  return {
    kind: note.kind,
    ...(note.title ? { title: note.title } : {}),
    ...(note.body ? { body: note.body } : {}),
    ...(note.target ? { target: note.target } : {}),
    ...(note.evidence.length > 0 ? { evidence: [...note.evidence] } : {}),
    ...(note.status ? { status: note.status } : {}),
    ...(note.confidence ? { confidence: note.confidence } : {}),
  };
}

function parsedPlanUpdateToToolCalls(
  update: ParsedMissionPlanUpdate,
): { tool: string; args: Record<string, unknown> }[] {
  if (update.action === 'create') {
    return [
      {
        tool: 'mission.plan.create',
        args: {
          title: update.title,
          ...(update.body ? { body: update.body } : {}),
          ...(update.status ? { status: update.status } : {}),
        },
      },
    ];
  }

  const planId = update.id || update.title;
  if ((update.status === 'archived' || update.status === 'superseded') && !update.body) {
    return [{ tool: 'mission.plan.archive', args: { planId, status: update.status } }];
  }
  if (update.status === 'active' && !update.body && !update.title) {
    return [{ tool: 'mission.plan.activate', args: { planId } }];
  }

  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const updateArgs = {
    planId,
    ...(update.title && update.id ? { title: update.title } : {}),
    ...(update.body ? { body: update.body } : {}),
  };
  if (updateArgs.title || updateArgs.body) {
    calls.push({
      tool: 'mission.plan.update',
      args: updateArgs,
    });
  }
  if (update.status === 'active') {
    calls.push({ tool: 'mission.plan.activate', args: { planId } });
  } else if (update.status === 'archived' || update.status === 'superseded') {
    calls.push({ tool: 'mission.plan.archive', args: { planId, status: update.status } });
  }
  return calls;
}

function parsedPhaseUpdateToToolCall(
  update: ParsedMissionPhaseUpdate,
  ctx: MissionPhaseRoutingContext,
): { tool: string; args: Record<string, unknown> } {
  const effectivePlan =
    update.planRef || (ctx.forcePlanOnUpdates && ctx.defaultPlanId ? ctx.defaultPlanId : '');
  if (update.action === 'create') {
    return {
      tool: 'mission.phase.create',
      args: {
        title: update.title,
        ...(effectivePlan ? { plan: effectivePlan } : {}),
        ...(update.description ? { description: update.description } : {}),
        ...(update.gate ? { gate: update.gate } : {}),
        ...(update.status && update.status !== 'done' ? { status: update.status } : {}),
        ...(update.sortOrder !== null ? { sortOrder: update.sortOrder } : {}),
      },
    };
  }
  if (update.status === 'done') {
    return {
      tool: 'mission.phase.complete',
      args: {
        phaseId: update.id || update.title,
        ...(update.description ? { note: update.description } : {}),
        ...(update.gate ? { evidence: update.gate } : {}),
      },
    };
  }
  return {
    tool: 'mission.phase.update',
    args: {
      phaseId: update.id || update.title,
      ...(update.title && update.id ? { title: update.title } : {}),
      ...(effectivePlan ? { plan: effectivePlan } : {}),
      ...(update.description ? { description: update.description } : {}),
      ...(update.gate ? { gate: update.gate } : {}),
      ...(update.status ? { status: update.status } : {}),
      ...(update.sortOrder !== null ? { sortOrder: update.sortOrder } : {}),
    },
  };
}

function completedPhaseFromOutcome(
  ctx: MissionPhaseRoutingContext,
  outcome: ExecuteToolCallOutcome,
): TaskPhase | null {
  const phaseId =
    ((outcome.result?.data as { phase?: { id?: unknown } } | undefined)?.phase?.id as
      | string
      | undefined) ?? '';
  if (!ctx.mission || !phaseId) return null;
  return listTaskPhases(ctx.db, ctx.mission.id).find((phase) => phase.id === phaseId) ?? null;
}

function createPlanIdempotencyKey(
  runId: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  const target = stringArg(args, 'planId') || stringArg(args, 'title') || 'unresolved';
  const body = stringArg(args, 'body');
  const status = stringArg(args, 'status');
  const hash = createHash('sha1')
    .update(`${body}\n${status}\n${stringArg(args, 'title')}`)
    .digest('hex')
    .slice(0, 12);
  return `${runId}:${tool}:${slug(target)}:${hash}`;
}

function createPhaseIdempotencyKey(
  runId: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  const target = stringArg(args, 'phaseId') || stringArg(args, 'title') || 'unresolved';
  const status = stringArg(args, 'status') || (tool === 'mission.phase.complete' ? 'done' : 'noop');
  const hash = createHash('sha1')
    .update(
      `${stringArg(args, 'description')}\n${stringArg(args, 'gate')}\n${stringArg(args, 'plan')}`,
    )
    .digest('hex')
    .slice(0, 12);
  return `${runId}:${tool}:${slug(target)}:${status}:${hash}`;
}

function createCollabNoteIdempotencyKey(runId: string, note: ParsedCollaborationNote): string {
  const fingerprint = `${note.kind}\n${note.title}\n${note.body}\n${note.target}`;
  const hash = createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);
  return `${runId}:collab.note.add:${note.kind}:${hash}`;
}

interface IdempotencyInput {
  runId: string;
  tool: string;
  update: ParsedMissionTaskUpdate;
}

/**
 * Stable per-run dedup key. For status-bearing updates the status is part of
 * the key so a follow-up status flip is not collapsed as a duplicate. For
 * notes the body hash is part of the key — same agent re-emitting the exact
 * same body will dedup, but a different note will not.
 */
function createIdempotencyKey(input: IdempotencyInput): string {
  const target = input.update.id || slug(input.update.title) || 'unresolved';
  if (input.update.action === 'note') {
    const hash = createHash('sha1').update(input.update.note).digest('hex').slice(0, 12);
    return `${input.runId}:${input.tool}:${target}:${hash}`;
  }
  const status = input.update.status ?? 'noop';
  return `${input.runId}:${input.tool}:${target}:${status}`;
}

function createPermissionRequestIdempotencyKey(input: {
  runId: string;
  target: string;
  reason: string;
}): string {
  const hash = createHash('sha1').update(input.reason).digest('hex').slice(0, 12);
  return `${input.runId}:permission.request:${slug(input.target) || 'unresolved'}:${hash}`;
}

function permissionRequestToArgs(request: ParsedPermissionRequest): Record<string, unknown> {
  return {
    mode: request.mode,
    target: request.target,
    reason: request.reason,
    requestedMode: request.requestedMode,
    capabilities: request.capabilities,
  };
}

function parsedPermissionRequestFromOutcome(
  outcome: ExecuteToolCallOutcome,
): ParsedPermissionRequest | null {
  if (outcome.status !== 'applied') return null;
  const data = outcome.result?.data;
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Partial<ParsedPermissionRequest>;
  if (
    typeof candidate.mode !== 'string' ||
    typeof candidate.requestedMode !== 'string' ||
    typeof candidate.target !== 'string' ||
    typeof candidate.reason !== 'string' ||
    !Array.isArray(candidate.capabilities)
  ) {
    return null;
  }
  return candidate as ParsedPermissionRequest;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function parsedUpdateToUpdateArgs(
  update: ParsedMissionTaskUpdate,
  ctx: MissionTaskRoutingContext,
): Record<string, unknown> {
  const planRef = update.planRef.trim();
  const effectivePlan =
    planRef.length > 0
      ? planRef
      : ctx.forcePlanOnUpdates && ctx.defaultPlanId
        ? ctx.defaultPlanId
        : '';
  const args: Record<string, unknown> = {
    action: 'update',
    taskId: update.id,
  };
  if (update.title) args.title = update.title;
  if (update.detail) args.detail = update.detail;
  if (update.invalidStatus) args.status = update.invalidStatus;
  else if (update.status) args.status = update.status;
  if (update.ownerAgentId) args.owner = update.ownerAgentId;
  if (update.note) args.note = update.note;
  if (update.noteKind) args.noteKind = update.noteKind;
  if (effectivePlan) args.plan = effectivePlan;
  if (update.phaseRef) args.phase = update.phaseRef;
  if (update.dependencyRefs.length > 0) args.dependsOn = update.dependencyRefs;
  if (update.expectedTouches.length > 0) args.expectedTouches = update.expectedTouches;
  if (update.parallelism) args.parallelism = update.parallelism;
  if (update.conflictGroup) args.conflictGroup = update.conflictGroup;
  if (update.workRole) args.workRole = update.workRole;
  if (update.blockedReason) args.blockedReason = update.blockedReason;
  if (update.councilRequired !== null) args.councilRequired = update.councilRequired;
  return args;
}

function parsedUpdateToAddNoteArgs(update: ParsedMissionTaskUpdate): Record<string, unknown> {
  const args: Record<string, unknown> = {
    taskId: update.id || update.title,
    body: update.note,
  };
  if (update.noteKind) args.kind = update.noteKind;
  return args;
}

function parsedUpdateToArgs(update: ParsedMissionTaskUpdate): Record<string, unknown> {
  return {
    action: update.action,
    taskId: update.id,
    title: update.title,
    detail: update.detail,
    status: update.invalidStatus || update.status,
    note: update.note,
    plan: update.planRef,
    phase: update.phaseRef,
    dependsOn: update.dependencyRefs,
    expectedTouches: update.expectedTouches,
    parallelism: update.parallelism,
    conflictGroup: update.conflictGroup,
    workRole: update.workRole,
    owner: update.ownerAgentId,
    blockedReason: update.blockedReason,
    councilRequired: update.councilRequired,
  };
}
