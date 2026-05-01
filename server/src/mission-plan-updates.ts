import type { TaskPlanStatus } from './repos/task-plans.js';

export type MissionPlanAction = 'create' | 'update';

export interface ParsedMissionPlanUpdate {
  action: MissionPlanAction;
  id: string;
  title: string;
  body: string;
  status: TaskPlanStatus | null;
}

export interface ExtractedMissionPlanUpdates {
  visibleText: string;
  updates: ParsedMissionPlanUpdate[];
}

const PLAN_RE =
  /(^|\n)\/mission-plan\s*\n([\s\S]*?)\n[/@]end-(?:mission-plan|collab-note)(?=\s|$)/gi;
const STATUSES = new Set(['draft', 'active', 'superseded', 'archived']);

function normalizeAction(value: string): MissionPlanAction {
  const normalized = value.trim().toLowerCase();
  if (['create', 'publish', 'new'].includes(normalized)) return 'create';
  if (['update', 'revise', 'revision'].includes(normalized)) return 'update';
  return 'update';
}

function normalizeStatus(value: string): TaskPlanStatus | null {
  const normalized = value.trim().toLowerCase();
  return STATUSES.has(normalized) ? (normalized as TaskPlanStatus) : null;
}

function parsePlanBlock(block: string): ParsedMissionPlanUpdate | null {
  const fields = new Map<string, string>();
  const bodyLines: string[] = [];
  let inBody = false;

  for (const rawLine of block.split(/\r?\n/)) {
    if (inBody) {
      bodyLines.push(rawLine);
      continue;
    }

    const match = /^([a-z][a-z_-]*)\s*:\s*(.*)$/i.exec(rawLine.trimEnd());
    if (!match) continue;
    const key = match[1]!.trim().toLowerCase().replace(/-/g, '_');
    const value = match[2] ?? '';
    if (['body', 'content', 'markdown'].includes(key)) {
      inBody = true;
      if (value.trim()) bodyLines.push(value);
      continue;
    }
    fields.set(key, value.trim());
  }

  const action = normalizeAction(fields.get('action') ?? fields.get('mode') ?? '');
  const id = fields.get('id') ?? fields.get('plan_id') ?? '';
  const title = fields.get('title') ?? fields.get('name') ?? '';
  const body = bodyLines.join('\n').trim();

  if (action === 'create' && !title) return null;
  if (action !== 'create' && !id && !title && !body) return null;

  return {
    action,
    id,
    title,
    body,
    status: normalizeStatus(fields.get('status') ?? 'active'),
  };
}

export function extractMissionPlanUpdates(text: string): ExtractedMissionPlanUpdates {
  const updates: ParsedMissionPlanUpdate[] = [];
  const visibleText = text.replace(PLAN_RE, (match, prefix: string, block: string) => {
    const parsed = parsePlanBlock(block);
    if (parsed) updates.push(parsed);
    return prefix === '\n' ? '\n' : '';
  });
  return {
    visibleText: visibleText.trim(),
    updates,
  };
}
