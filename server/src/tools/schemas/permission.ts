// server/src/tools/schemas/permission.ts
//
// Schema skeletons for the `permission.*` tool family. Phase 4 (design pass)
// only fixes the contract; the Milestone 4 handler will wrap the existing
// `buildPermissionGrant` and broker permission orchestrator. See
// docs/phase-4-permission-collab-design-2026-05-07.md for the full design.

import {
  PERMISSION_CAPABILITIES,
  PERMISSION_MODES,
  YOLO_FILESYSTEM_SCOPES,
  type PermissionCapability,
  type PermissionMode,
  type YoloFilesystemScope,
} from '../../permissions.js';

const TARGET_MAX = 500;
const REASON_MAX = 1000;

const MODE_SET: ReadonlySet<PermissionMode> = new Set<PermissionMode>(PERMISSION_MODES);
const SCOPE_SET: ReadonlySet<YoloFilesystemScope> = new Set<YoloFilesystemScope>(
  YOLO_FILESYSTEM_SCOPES,
);
const CAPABILITY_SET: ReadonlySet<PermissionCapability> = new Set<PermissionCapability>(
  PERMISSION_CAPABILITIES,
);

export interface PermissionRequestArgs {
  mode: PermissionMode;
  target: string;
  reason: string;
  /** Raw alias the agent typed (e.g. "shell"); kept for audit display. */
  requestedMode?: string;
  capabilities?: PermissionCapability[];
  filesystemScope?: YoloFilesystemScope;
  web?: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function requireString(input: UnknownRecord, key: string, max: number): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`${key} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${key} is required`);
  if (trimmed.length > max) {
    throw new Error(`${key} exceeds ${max} characters`);
  }
  return trimmed;
}

function optionalString(input: UnknownRecord, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value.trim();
}

function parseCapabilities(value: unknown): PermissionCapability[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('capabilities must be an array');
  const out: PermissionCapability[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const candidate = raw.trim();
    if (!candidate) continue;
    if (!CAPABILITY_SET.has(candidate as PermissionCapability)) {
      throw new Error(`unknown capability: ${candidate}`);
    }
    if (!out.includes(candidate as PermissionCapability)) {
      out.push(candidate as PermissionCapability);
    }
  }
  return out;
}

export function parsePermissionRequestArgs(input: unknown): PermissionRequestArgs {
  if (!isRecord(input)) throw new Error('permission.request args must be an object');

  const rawMode = optionalString(input, 'mode') ?? '';
  if (!rawMode) throw new Error('mode is required');
  if (!MODE_SET.has(rawMode as PermissionMode)) {
    throw new Error(`unknown permission mode: ${rawMode}`);
  }

  const target = requireString(input, 'target', TARGET_MAX);
  const reason = requireString(input, 'reason', REASON_MAX);
  const requestedMode = optionalString(input, 'requestedMode');
  const capabilities = parseCapabilities(input.capabilities);

  const filesystemScopeRaw = optionalString(input, 'filesystemScope');
  let filesystemScope: YoloFilesystemScope | undefined;
  if (filesystemScopeRaw !== undefined) {
    if (!SCOPE_SET.has(filesystemScopeRaw as YoloFilesystemScope)) {
      throw new Error(`unknown filesystemScope: ${filesystemScopeRaw}`);
    }
    filesystemScope = filesystemScopeRaw as YoloFilesystemScope;
  }

  const webRaw = input.web;
  let web: boolean | undefined;
  if (webRaw !== undefined && webRaw !== null) {
    if (typeof webRaw !== 'boolean') throw new Error('web must be a boolean');
    web = webRaw;
  }

  return {
    mode: rawMode as PermissionMode,
    target,
    reason,
    ...(requestedMode !== undefined ? { requestedMode } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(filesystemScope !== undefined ? { filesystemScope } : {}),
    ...(web !== undefined ? { web } : {}),
  };
}
