import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import {
  buildPermissionGrant,
  type PermissionCapability,
  type PermissionTargetKind,
  type ParsedPermissionRequest,
  type PermissionRequest,
  type PermissionStatus,
} from '../permissions.js';
import type { AgentId } from '../agents/types.js';

interface PermissionRequestRow {
  id: string;
  room_id: string;
  agent_id: AgentId;
  mode: PermissionRequest['mode'];
  requested_mode: string;
  target: string;
  reason: string;
  capabilities_json: string;
  target_exists: number | null;
  target_kind: PermissionTargetKind;
  target_resolved_path: string;
  target_checked_at: number;
  provider_profile: string;
  status: PermissionStatus;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

function parseCapabilities(json: string): PermissionCapability[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PermissionCapability => typeof item === 'string');
  } catch {
    return [];
  }
}

function rowToPermissionRequest(row: PermissionRequestRow): PermissionRequest {
  const capabilities = parseCapabilities(row.capabilities_json);
  const fallback =
    capabilities.length === 0
      ? buildPermissionGrant({
          agentId: row.agent_id,
          mode: row.mode,
          requestedMode: row.requested_mode || row.mode,
          target: row.target,
          reason: row.reason,
        })
      : null;
  return {
    id: row.id,
    roomId: row.room_id,
    agentId: row.agent_id,
    mode: row.mode,
    requestedMode: row.requested_mode || row.mode,
    target: row.target,
    reason: row.reason,
    capabilities: capabilities.length > 0 ? capabilities : fallback?.capabilities ?? [],
    targetExists:
      row.target_exists === null ? (fallback?.targetExists ?? null) : row.target_exists === 1,
    targetKind: row.target_kind || fallback?.targetKind || 'unknown',
    targetResolvedPath: row.target_resolved_path || fallback?.targetResolvedPath || '',
    targetCheckedAt: row.target_checked_at || fallback?.targetCheckedAt || row.created_at,
    providerProfile: row.provider_profile || fallback?.providerProfile || '',
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export function addPermissionRequest(
  db: Database,
  input: Pick<ParsedPermissionRequest, 'mode' | 'target' | 'reason'> &
    Partial<Omit<ParsedPermissionRequest, 'mode' | 'target' | 'reason'>> & {
      roomId: string;
      agentId: AgentId;
    },
): PermissionRequest {
  const id = nanoid(16);
  const now = Date.now();
  const resolved =
    input.capabilities && input.providerProfile
      ? (input as ParsedPermissionRequest)
      : buildPermissionGrant({
          agentId: input.agentId,
          mode: input.mode,
          target: input.target,
          reason: input.reason,
          ...(input.requestedMode ? { requestedMode: input.requestedMode } : {}),
        });
  db.prepare(
    `INSERT INTO permission_requests
      (id, room_id, agent_id, mode, requested_mode, target, reason, capabilities_json,
       target_exists, target_kind, target_resolved_path, target_checked_at, provider_profile,
       status, created_at, decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
  ).run(
    id,
    input.roomId,
    input.agentId,
    resolved.mode,
    resolved.requestedMode,
    resolved.target,
    resolved.reason,
    JSON.stringify(resolved.capabilities),
    resolved.targetExists === null ? null : resolved.targetExists ? 1 : 0,
    resolved.targetKind,
    resolved.targetResolvedPath,
    resolved.targetCheckedAt,
    resolved.providerProfile,
    now,
  );
  return {
    id,
    roomId: input.roomId,
    agentId: input.agentId,
    mode: resolved.mode,
    requestedMode: resolved.requestedMode,
    target: resolved.target,
    reason: resolved.reason,
    capabilities: resolved.capabilities,
    targetExists: resolved.targetExists,
    targetKind: resolved.targetKind,
    targetResolvedPath: resolved.targetResolvedPath,
    targetCheckedAt: resolved.targetCheckedAt,
    providerProfile: resolved.providerProfile,
    status: 'pending',
    createdAt: now,
    decidedAt: null,
    decidedBy: null,
  };
}

export function getPermissionRequest(db: Database, id: string): PermissionRequest | null {
  const row = db
    .prepare(`SELECT * FROM permission_requests WHERE id = ?`)
    .get(id) as PermissionRequestRow | undefined;
  return row ? rowToPermissionRequest(row) : null;
}

export function listPermissionRequests(db: Database, roomId: string): PermissionRequest[] {
  const rows = db
    .prepare(`SELECT * FROM permission_requests WHERE room_id = ? ORDER BY created_at ASC, id ASC`)
    .all(roomId) as PermissionRequestRow[];
  return rows.map(rowToPermissionRequest);
}

export function resolvePermissionRequest(
  db: Database,
  input: { id: string; decision: Exclude<PermissionStatus, 'pending'>; decidedBy: string },
): PermissionRequest | null {
  const existing = getPermissionRequest(db, input.id);
  if (!existing) return null;
  if (existing.status !== 'pending') return existing;

  const decidedAt = Date.now();
  db.prepare(
    `UPDATE permission_requests
       SET status = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(input.decision, decidedAt, input.decidedBy, input.id);

  return getPermissionRequest(db, input.id);
}
