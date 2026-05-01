export type WorkItemSourceKind = 'markdown' | 'github' | 'linear';

export type WorkItemPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export type WorkItemState =
  | 'todo'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'canceled';

export interface WorkItemSource {
  kind: WorkItemSourceKind;
  name: string;
  externalId: string;
}

export interface WorkItem {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: WorkItemPriority;
  state: WorkItemState;
  branchName: string;
  url: string;
  labels: string[];
  blockedBy: string[];
  source: WorkItemSource;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface IntakeValidationResult {
  ok: boolean;
  errors: string[];
}

export interface WorkIntakeAdapter<TRaw> {
  kind: WorkItemSourceKind;
  validate(input: unknown): IntakeValidationResult;
  collect(input: TRaw): WorkItem[];
}

export interface MarkdownTaskFileInput {
  content: string;
  path?: string;
  sourceName?: string;
}

export interface MarkdownTaskFileOptions {
  path?: string;
  sourceName?: string;
}

export interface GitHubIssueInput {
  id: number | string;
  number: number;
  title: string;
  body?: string | null;
  state?: string | null;
  state_reason?: string | null;
  html_url?: string | null;
  labels?: Array<string | { name?: string | null }>;
  created_at?: string | null;
  updated_at?: string | null;
  branchName?: string | null;
}

export interface GitHubIssueAdapterOptions {
  owner?: string;
  repo?: string;
}

export interface LinearIssueInput {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | string | null;
  state?: string | { name?: string | null; type?: string | null } | null;
  branchName?: string | null;
  url?: string | null;
  labels?: Array<string | { name?: string | null }>;
  blockedBy?: Array<string | { id?: string | null; identifier?: string | null }>;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LinearIssueAdapterOptions {
  workspace?: string;
}

export type WorkItemStateMatcher = WorkItemState | 'active' | 'terminal' | 'dispatchable';

const TERMINAL_STATES = new Set<WorkItemState>(['done', 'canceled']);

const PRIORITY_RANK: Record<WorkItemPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const STATE_ALIASES = new Map<string, WorkItemState>([
  ['accepted', 'done'],
  ['backlog', 'todo'],
  ['blocked', 'blocked'],
  ['canceled', 'canceled'],
  ['cancelled', 'canceled'],
  ['closed', 'done'],
  ['complete', 'done'],
  ['completed', 'done'],
  ['deferred', 'canceled'],
  ['done', 'done'],
  ['duplicate', 'canceled'],
  ['finished', 'done'],
  ['in progress', 'in_progress'],
  ['in review', 'review'],
  ['in-progress', 'in_progress'],
  ['in_progress', 'in_progress'],
  ['merged', 'done'],
  ['needs review', 'review'],
  ['needs_review', 'review'],
  ['new', 'todo'],
  ['not planned', 'canceled'],
  ['not_planned', 'canceled'],
  ['open', 'todo'],
  ['pending', 'todo'],
  ['planned', 'ready'],
  ['ready', 'ready'],
  ['resolved', 'done'],
  ['review', 'review'],
  ['skipped', 'canceled'],
  ['started', 'in_progress'],
  ['stuck', 'blocked'],
  ['todo', 'todo'],
  ['triage', 'todo'],
  ['unstarted', 'todo'],
  ['verify', 'review'],
  ['verifying', 'review'],
  ['waiting', 'blocked'],
  ['working', 'in_progress'],
  ['wontfix', 'canceled'],
]);

const PRIORITY_ALIASES = new Map<string, WorkItemPriority>([
  ['0', 'none'],
  ['1', 'urgent'],
  ['2', 'high'],
  ['3', 'medium'],
  ['4', 'low'],
  ['blocker', 'urgent'],
  ['critical', 'urgent'],
  ['high', 'high'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['normal', 'medium'],
  ['none', 'none'],
  ['no priority', 'none'],
  ['no_priority', 'none'],
  ['p0', 'urgent'],
  ['p1', 'high'],
  ['p2', 'medium'],
  ['p3', 'low'],
  ['p4', 'none'],
  ['urgent', 'urgent'],
]);

const MARKDOWN_TASK_RE = /^(\s*)[-*]\s+\[([ xX~-])\]\s+(.+)$/;
const INLINE_FIELD_RE =
  /(^|\s)(id|identifier|priority|state|status|branch|branch_name|url|blocked-by|blocked_by|depends-on|depends_on|created):([^\s]+)/gi;
const MARKDOWN_LABEL_RE = /(^|\s)#([A-Za-z][A-Za-z0-9_-]*)\b/g;

export function normalizeWorkItemState(
  value: string | null | undefined,
  fallback: WorkItemState = 'todo',
): WorkItemState {
  const normalized = (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return fallback;
  return STATE_ALIASES.get(normalized) ?? fallback;
}

export function normalizeWorkItemPriority(
  value: string | number | null | undefined,
  fallback: WorkItemPriority = 'medium',
): WorkItemPriority {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!normalized) return fallback;
  return PRIORITY_ALIASES.get(normalized) ?? fallback;
}

export function isTerminalWorkItemState(state: WorkItemState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isActiveWorkItemState(state: WorkItemState): boolean {
  return !isTerminalWorkItemState(state);
}

export function isTerminalWorkItem(item: WorkItem): boolean {
  return isTerminalWorkItemState(item.state);
}

export function isActiveWorkItem(item: WorkItem): boolean {
  return isActiveWorkItemState(item.state);
}

export function matchesWorkItemState(
  item: WorkItem,
  matcher: WorkItemStateMatcher,
  items: Iterable<WorkItem> | Map<string, WorkItem> = [],
): boolean {
  if (matcher === 'active') return isActiveWorkItem(item);
  if (matcher === 'terminal') return isTerminalWorkItem(item);
  if (matcher === 'dispatchable') return canDispatchWorkItem(item, items);
  return item.state === matcher;
}

export function isEligibleBlocker(blocker: WorkItem, blocked?: WorkItem): boolean {
  if (blocked && blocker.id === blocked.id) return false;
  return isActiveWorkItem(blocker);
}

export function unresolvedBlockerIds(
  item: WorkItem,
  items: Iterable<WorkItem> | Map<string, WorkItem>,
): string[] {
  const index = indexWorkItems(items);
  return item.blockedBy.filter((ref) => {
    const blocker = index.get(ref);
    if (!blocker) return true;
    return isEligibleBlocker(blocker, item);
  });
}

export function canDispatchWorkItem(
  item: WorkItem,
  items: Iterable<WorkItem> | Map<string, WorkItem> = [],
): boolean {
  return (
    isActiveWorkItem(item) &&
    item.state !== 'blocked' &&
    unresolvedBlockerIds(item, items).length === 0
  );
}

export function compareWorkItemsForDispatch(a: WorkItem, b: WorkItem): number {
  const priorityDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priorityDelta !== 0) return priorityDelta;
  const createdDelta = a.createdAt - b.createdAt;
  if (createdDelta !== 0) return createdDelta;
  return a.id.localeCompare(b.id);
}

export function sortWorkItemsForDispatch(items: readonly WorkItem[]): WorkItem[] {
  return [...items].sort(compareWorkItemsForDispatch);
}

export function selectDispatchableWorkItems(items: readonly WorkItem[]): WorkItem[] {
  return sortWorkItemsForDispatch(items.filter((item) => canDispatchWorkItem(item, items)));
}

export function validateMarkdownTaskFile(input: unknown): IntakeValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return validation(errors, 'input must be an object');
  }
  if (typeof input.content !== 'string') errors.push('content must be a string');
  if ('path' in input && input.path !== undefined && typeof input.path !== 'string') {
    errors.push('path must be a string when provided');
  }
  if (
    'sourceName' in input &&
    input.sourceName !== undefined &&
    typeof input.sourceName !== 'string'
  ) {
    errors.push('sourceName must be a string when provided');
  }
  return validation(errors);
}

export function parseMarkdownTaskFile(
  content: string,
  options: MarkdownTaskFileOptions = {},
): WorkItem[] {
  const sourceName = options.sourceName?.trim() || options.path?.trim() || 'markdown';
  const tasks: MarkdownTaskDraft[] = [];
  let current: MarkdownTaskDraft | null = null;
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = MARKDOWN_TASK_RE.exec(line);
    if (match) {
      if (current) tasks.push(current);
      current = {
        lineNumber: index + 1,
        checkbox: match[2] ?? ' ',
        rawTitle: match[3] ?? '',
        descriptionLines: [],
      };
      return;
    }

    if (current && line.trim() && /^\s+/.test(line)) {
      current.descriptionLines.push(line.trim());
    }
  });

  if (current) tasks.push(current);
  return tasks.map((task) => markdownDraftToWorkItem(task, sourceName, options.path));
}

export function validateGitHubIssue(input: unknown): IntakeValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return validation(errors, 'input must be an object');
  if (typeof input.id !== 'string' && typeof input.id !== 'number') {
    errors.push('id must be a string or number');
  }
  if (typeof input.number !== 'number' || !Number.isFinite(input.number)) {
    errors.push('number must be a finite number');
  }
  if (typeof input.title !== 'string' || !input.title.trim()) {
    errors.push('title must be a non-empty string');
  }
  if ('labels' in input && input.labels !== undefined && !Array.isArray(input.labels)) {
    errors.push('labels must be an array when provided');
  }
  return validation(errors);
}

export function githubIssueToWorkItem(
  issue: GitHubIssueInput,
  options: GitHubIssueAdapterOptions = {},
): WorkItem {
  assertValid(validateGitHubIssue(issue), 'Invalid GitHub issue');
  const repoName = [options.owner, options.repo].filter(Boolean).join('/');
  const identifier = repoName ? `${repoName}#${issue.number}` : `#${issue.number}`;
  const labels = normalizeLabels(issue.labels);
  const state = normalizeGitHubState(issue, labels);

  return {
    id: stableWorkItemId('github', identifier),
    identifier,
    title: issue.title.trim(),
    description: (issue.body ?? '').trim(),
    priority: priorityFromLabels(labels),
    state,
    branchName: (issue.branchName ?? '').trim(),
    url: (issue.html_url ?? '').trim(),
    labels,
    blockedBy: [],
    source: {
      kind: 'github',
      name: repoName || 'github',
      externalId: String(issue.id),
    },
    createdAt: parseTimestamp(issue.created_at),
    metadata: {
      number: issue.number,
      state: issue.state ?? null,
      stateReason: issue.state_reason ?? null,
      updatedAt: issue.updated_at ?? null,
    },
  };
}

export function validateLinearIssue(input: unknown): IntakeValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return validation(errors, 'input must be an object');
  if (typeof input.id !== 'string' || !input.id.trim()) {
    errors.push('id must be a non-empty string');
  }
  if (typeof input.identifier !== 'string' || !input.identifier.trim()) {
    errors.push('identifier must be a non-empty string');
  }
  if (typeof input.title !== 'string' || !input.title.trim()) {
    errors.push('title must be a non-empty string');
  }
  if ('labels' in input && input.labels !== undefined && !Array.isArray(input.labels)) {
    errors.push('labels must be an array when provided');
  }
  if ('blockedBy' in input && input.blockedBy !== undefined && !Array.isArray(input.blockedBy)) {
    errors.push('blockedBy must be an array when provided');
  }
  return validation(errors);
}

export function linearIssueToWorkItem(
  issue: LinearIssueInput,
  options: LinearIssueAdapterOptions = {},
): WorkItem {
  assertValid(validateLinearIssue(issue), 'Invalid Linear issue');
  const labels = normalizeLabels(issue.labels);
  const stateValue =
    typeof issue.state === 'string'
      ? issue.state
      : (issue.state?.type ?? issue.state?.name ?? undefined);

  return {
    id: stableWorkItemId('linear', issue.id),
    identifier: issue.identifier.trim(),
    title: issue.title.trim(),
    description: (issue.description ?? '').trim(),
    priority: normalizeWorkItemPriority(issue.priority, 'medium'),
    state: normalizeWorkItemState(stateValue),
    branchName: (issue.branchName ?? '').trim(),
    url: (issue.url ?? '').trim(),
    labels,
    blockedBy: normalizeLinearBlockedBy(issue.blockedBy),
    source: {
      kind: 'linear',
      name: options.workspace?.trim() || 'linear',
      externalId: issue.id.trim(),
    },
    createdAt: parseTimestamp(issue.createdAt),
    metadata: {
      stateName:
        typeof issue.state === 'object' ? (issue.state?.name ?? null) : (issue.state ?? null),
      stateType: typeof issue.state === 'object' ? (issue.state?.type ?? null) : null,
      updatedAt: issue.updatedAt ?? null,
    },
  };
}

export const markdownTaskFileAdapter: WorkIntakeAdapter<MarkdownTaskFileInput> = {
  kind: 'markdown',
  validate: validateMarkdownTaskFile,
  collect(input) {
    assertValid(validateMarkdownTaskFile(input), 'Invalid markdown task file');
    const options: MarkdownTaskFileOptions = {};
    if (input.path) options.path = input.path;
    if (input.sourceName) options.sourceName = input.sourceName;
    return parseMarkdownTaskFile(input.content, options);
  },
};

export function createGitHubIssueAdapter(
  options: GitHubIssueAdapterOptions = {},
): WorkIntakeAdapter<GitHubIssueInput> {
  return {
    kind: 'github',
    validate: validateGitHubIssue,
    collect(input) {
      return [githubIssueToWorkItem(input, options)];
    },
  };
}

export function createLinearIssueAdapter(
  options: LinearIssueAdapterOptions = {},
): WorkIntakeAdapter<LinearIssueInput> {
  return {
    kind: 'linear',
    validate: validateLinearIssue,
    collect(input) {
      return [linearIssueToWorkItem(input, options)];
    },
  };
}

interface MarkdownTaskDraft {
  lineNumber: number;
  checkbox: string;
  rawTitle: string;
  descriptionLines: string[];
}

function markdownDraftToWorkItem(
  draft: MarkdownTaskDraft,
  sourceName: string,
  path: string | undefined,
): WorkItem {
  const fields = parseInlineFields(draft.rawTitle);
  const labels = parseMarkdownLabels(draft.rawTitle);
  const withoutFields = stripInlineFields(draft.rawTitle);
  const withoutLabels = stripMarkdownLabels(withoutFields);
  const identifierResult = extractMarkdownIdentifier(
    withoutLabels.trim(),
    fields.get('identifier') ?? fields.get('id'),
    sourceName,
    draft.lineNumber,
  );
  const checkboxState = stateFromMarkdownCheckbox(draft.checkbox);
  const state = normalizeWorkItemState(
    fields.get('state') ?? fields.get('status') ?? checkboxState,
    checkboxState,
  );
  const branchName = fields.get('branch_name') ?? fields.get('branch') ?? '';
  const createdAt = parseTimestamp(fields.get('created'));

  return {
    id: stableWorkItemId('markdown', sourceName, identifierResult.identifier),
    identifier: identifierResult.identifier,
    title: identifierResult.title,
    description: draft.descriptionLines.join('\n').trim(),
    priority: normalizeWorkItemPriority(fields.get('priority'), 'medium'),
    state,
    branchName,
    url: fields.get('url') ?? '',
    labels,
    blockedBy: splitRefs(
      fields.get('blocked_by') ??
        fields.get('blocked-by') ??
        fields.get('depends_on') ??
        fields.get('depends-on') ??
        '',
    ),
    source: {
      kind: 'markdown',
      name: sourceName,
      externalId: path ? `${path}:${draft.lineNumber}` : String(draft.lineNumber),
    },
    createdAt,
    metadata: {
      line: draft.lineNumber,
      checked: draft.checkbox.toLowerCase() === 'x',
    },
  };
}

function normalizeGitHubState(issue: GitHubIssueInput, labels: string[]): WorkItemState {
  if ((issue.state ?? '').toLowerCase() === 'closed') {
    return normalizeWorkItemState(issue.state_reason === 'not_planned' ? 'not planned' : 'done');
  }
  const labelState = labels.find((label) => {
    const normalized = label.toLowerCase();
    return ['blocked', 'in-progress', 'in_progress', 'ready', 'review'].includes(normalized);
  });
  return normalizeWorkItemState(labelState ?? issue.state ?? 'todo');
}

function priorityFromLabels(labels: readonly string[]): WorkItemPriority {
  for (const label of labels) {
    const normalized = label
      .toLowerCase()
      .replace(/^priority[:-]/, '')
      .trim();
    const priority = PRIORITY_ALIASES.get(normalized);
    if (priority) return priority;
  }
  return 'medium';
}

function normalizeLinearBlockedBy(blockedBy: LinearIssueInput['blockedBy'] | undefined): string[] {
  return [
    ...new Set(
      (blockedBy ?? [])
        .map((blocker) => {
          if (typeof blocker === 'string') return blocker.trim();
          return (blocker.identifier ?? blocker.id ?? '').trim();
        })
        .filter(Boolean),
    ),
  ];
}

function normalizeLabels(labels: Array<string | { name?: string | null }> | undefined): string[] {
  return [
    ...new Set(
      (labels ?? [])
        .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function parseInlineFields(title: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of title.matchAll(INLINE_FIELD_RE)) {
    const key = match[2]?.toLowerCase().replace(/-/g, '_');
    const value = match[3]?.trim();
    if (key && value && !fields.has(key)) fields.set(key, value);
  }
  return fields;
}

function stripInlineFields(title: string): string {
  return title.replace(INLINE_FIELD_RE, ' ').replace(/\s+/g, ' ').trim();
}

function parseMarkdownLabels(title: string): string[] {
  const labels: string[] = [];
  for (const match of title.matchAll(MARKDOWN_LABEL_RE)) {
    const label = match[2]?.trim();
    if (label) labels.push(label);
  }
  return [...new Set(labels)].sort((a, b) => a.localeCompare(b));
}

function stripMarkdownLabels(title: string): string {
  return title.replace(MARKDOWN_LABEL_RE, ' ').replace(/\s+/g, ' ').trim();
}

function extractMarkdownIdentifier(
  title: string,
  explicitIdentifier: string | undefined,
  sourceName: string,
  lineNumber: number,
): { identifier: string; title: string } {
  if (explicitIdentifier?.trim()) {
    return {
      identifier: explicitIdentifier.trim(),
      title: title || explicitIdentifier.trim(),
    };
  }

  const bracketMatch = /^(?:\[|\(|\{)([A-Za-z][A-Za-z0-9_-]*-\d+|#[0-9]+)(?:\]|\)|\})\s*(.+)$/.exec(
    title,
  );
  if (bracketMatch) {
    return {
      identifier: bracketMatch[1] ?? `${sourceName}:${lineNumber}`,
      title: (bracketMatch[2] ?? '').trim(),
    };
  }

  const prefixMatch = /^([A-Za-z][A-Za-z0-9_-]*-\d+|#[0-9]+)\s*[:-]\s+(.+)$/.exec(title);
  if (prefixMatch) {
    return {
      identifier: prefixMatch[1] ?? `${sourceName}:${lineNumber}`,
      title: (prefixMatch[2] ?? '').trim(),
    };
  }

  const identifier = `${sourceName}:${lineNumber}`;
  return {
    identifier,
    title: title || identifier,
  };
}

function stateFromMarkdownCheckbox(checkbox: string): WorkItemState {
  const normalized = checkbox.trim().toLowerCase();
  if (normalized === 'x') return 'done';
  if (normalized === '-') return 'blocked';
  if (normalized === '~') return 'canceled';
  return 'todo';
}

function splitRefs(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,;|]/)
        .map((ref) => ref.trim())
        .filter(Boolean),
    ),
  ];
}

function indexWorkItems(items: Iterable<WorkItem> | Map<string, WorkItem>): Map<string, WorkItem> {
  if (items instanceof Map) return items;
  const index = new Map<string, WorkItem>();
  for (const item of items) {
    index.set(item.id, item);
    index.set(item.identifier, item);
  }
  return index;
}

function stableWorkItemId(kind: WorkItemSourceKind, ...parts: string[]): string {
  const tail = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(':')
    .replace(/[^A-Za-z0-9_.:#/-]+/g, '-')
    .replace(/-+/g, '-');
  return `${kind}:${tail}`;
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validation(errors: string[], firstError?: string): IntakeValidationResult {
  return {
    ok: errors.length === 0 && !firstError,
    errors: firstError ? [firstError, ...errors] : errors,
  };
}

function assertValid(result: IntakeValidationResult, prefix: string): void {
  if (!result.ok) {
    throw new TypeError(`${prefix}: ${result.errors.join('; ')}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
