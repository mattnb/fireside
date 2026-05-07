#!/usr/bin/env node
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOM_ID = '5YZGXgDK6e5M';
const DEFAULT_SINCE = '2026-05-07T00:26:47.019Z';

function usage() {
  console.log(`Usage: node scripts/measure-run-kind-baseline.mjs [options]

Options:
  --db <path>       SQLite DB path (default: data/fireside.sqlite)
  --room <id>       Room id (default: ${DEFAULT_ROOM_ID})
  --since <iso|ms>  Inclusive run-start lower bound (default: ${DEFAULT_SINCE})
  --until <iso|ms>  Exclusive run-start upper bound (default: now)
  --json            Print JSON instead of markdown
  --help            Show this message
`);
}

function parseArgs(argv) {
  const args = {
    db: 'data/fireside.sqlite',
    room: DEFAULT_ROOM_ID,
    since: parseTime(DEFAULT_SINCE),
    until: Date.now(),
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === '--db') {
      args.db = next;
      i += 1;
      continue;
    }
    if (arg === '--room') {
      args.room = next;
      i += 1;
      continue;
    }
    if (arg === '--since') {
      args.since = parseTime(next);
      i += 1;
      continue;
    }
    if (arg === '--until') {
      args.until = parseTime(next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isFinite(args.since) || !Number.isFinite(args.until) || args.until <= args.since) {
    throw new Error('Invalid time window');
  }
  return args;
}

function parseTime(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed;
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function parseContextUsage(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.quotaOnly === true) return null;
    if (typeof parsed.usedTokens !== 'number' || !Number.isFinite(parsed.usedTokens)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function classifyRun(run) {
  if (typeof run.persisted_run_kind === 'string' && run.persisted_run_kind.length > 0) {
    return run.persisted_run_kind;
  }
  if (run.is_compact_prompt === 1) return 'maintenance.compaction';
  if (run.is_workflow_repair_trigger === 1) return 'workflow.repair';
  return 'normal.turn';
}

function pct(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function ratio(providerTokens, liveTokens) {
  if (!liveTokens) return providerTokens ? 'n/a' : '0.00x';
  return `${(providerTokens / liveTokens).toFixed(2)}x`;
}

function number(value) {
  return Math.round(value).toLocaleString('en-US');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function addMetric(map, key, run) {
  const metric = map.get(key) ?? {
    key,
    runs: 0,
    usageRuns: 0,
    liveTokens: 0,
    providerTokens: 0,
    resumedRuns: 0,
    visibleRuns: 0,
    noProgressRuns: 0,
    missionUpdates: 0,
    missionReceipts: 0,
    missionReconciliations: 0,
    collaborationNotes: 0,
    failedOutcomes: 0,
  };
  metric.runs += 1;
  metric.usageRuns += run.provider_tokens > 0 ? 1 : 0;
  metric.liveTokens += run.estimated_prompt_tokens ?? 0;
  metric.providerTokens += run.provider_tokens;
  metric.resumedRuns += run.cli_session_id ? 1 : 0;
  metric.visibleRuns += run.visible_message_emitted === 1 ? 1 : 0;
  metric.noProgressRuns +=
    run.visible_message_emitted === 0 && run.progressed === 0 && run.failed === 0 ? 1 : 0;
  metric.missionUpdates += run.mission_updates ?? 0;
  metric.missionReceipts += run.mission_receipts ?? 0;
  metric.missionReconciliations += run.mission_reconciliations ?? 0;
  metric.collaborationNotes += run.collaboration_notes ?? 0;
  metric.failedOutcomes += run.failed === 1 ? 1 : 0;
  map.set(key, metric);
}

function sortedMetrics(map) {
  return [...map.values()].sort((a, b) => b.providerTokens - a.providerTokens || b.runs - a.runs);
}

function metricRow(metric, totalProviderTokens) {
  return [
    metric.key,
    number(metric.runs),
    number(metric.usageRuns),
    number(metric.liveTokens),
    number(metric.providerTokens),
    ratio(metric.providerTokens, metric.liveTokens),
    pct(metric.providerTokens, totalProviderTokens),
    `${number(metric.resumedRuns)} (${pct(metric.resumedRuns, metric.runs)})`,
    `${number(metric.noProgressRuns)} (${pct(metric.noProgressRuns, metric.runs)})`,
  ];
}

function markdownTable(headers, rows) {
  const header = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [header, sep, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

function collect(db, args) {
  const outcomeHasRunKind = hasColumn(db, 'agent_turn_outcomes', 'run_kind');
  const runKindSelect = outcomeHasRunKind ? 'o.run_kind AS persisted_run_kind,' : "'' AS persisted_run_kind,";

  const runs = db
    .prepare(
      `SELECT
         r.id,
         r.room_id,
         r.task_id,
         r.agent_id,
         r.status,
         r.estimated_prompt_tokens,
         r.started_at,
         r.completed_at,
         r.cli_session_id,
         r.reply_message_id,
         rooms.lead_agent_id,
         ${runKindSelect}
         o.id AS outcome_id,
         COALESCE(o.visible_message_emitted, 0) AS visible_message_emitted,
         COALESCE(o.progressed, 0) AS progressed,
         COALESCE(o.failed, 0) AS failed,
         COALESCE(o.mission_updates, 0) AS mission_updates,
         COALESCE(o.mission_receipts, 0) AS mission_receipts,
         COALESCE(o.mission_reconciliations, 0) AS mission_reconciliations,
         COALESCE(o.collaboration_notes, 0) AS collaboration_notes,
         CASE WHEN TRIM(COALESCE(r.prompt_text, '')) = '/compact' THEN 1 ELSE 0 END AS is_compact_prompt,
         CASE
           WHEN m.author_kind = 'system'
            AND m.text LIKE '(fireside workflow contract repair for %'
           THEN 1 ELSE 0
         END AS is_workflow_repair_trigger
       FROM agent_runs r
       LEFT JOIN rooms ON rooms.id = r.room_id
       LEFT JOIN agent_turn_outcomes o ON o.run_id = r.id
       LEFT JOIN messages m ON m.id = r.trigger_message_id
       WHERE r.room_id = ?
         AND r.started_at >= ?
         AND r.started_at < ?
         AND r.status IN ('completed', 'empty', 'permission-requested', 'failed')
       ORDER BY r.started_at ASC`,
    )
    .all(args.room, args.since, args.until);

  const usageByRun = new Map();
  const usageRows = db
    .prepare(
      `SELECT run_id, context_usage_json
       FROM agent_run_actions
       WHERE room_id = ?
         AND created_at >= ?
         AND created_at < ?
         AND context_usage_json <> ''`,
    )
    .all(args.room, args.since, args.until);
  for (const row of usageRows) {
    const usage = parseContextUsage(row.context_usage_json);
    if (!usage) continue;
    const current = usageByRun.get(row.run_id) ?? 0;
    if (usage.usedTokens > current) {
      usageByRun.set(row.run_id, usage.usedTokens);
    }
  }

  const kindMetrics = new Map();
  const roleSessionMetrics = new Map();
  const agentMetrics = new Map();
  const taskIds = new Set();
  const classifiedRuns = runs.flatMap((run) => {
    const runKind = classifyRun(run);
    const role = run.agent_id === run.lead_agent_id ? 'lead' : 'worker';
    const session = run.cli_session_id ? 'resumed' : 'fresh';
    const providerTokens = usageByRun.get(run.id) ?? 0;
    if (!run.outcome_id && providerTokens === 0) {
      return [];
    }
    const classified = {
      ...run,
      run_kind: runKind,
      role,
      session,
      provider_tokens: providerTokens,
    };
    if (run.task_id) taskIds.add(run.task_id);
    addMetric(kindMetrics, runKind, classified);
    addMetric(roleSessionMetrics, `${role}.${session}`, classified);
    addMetric(agentMetrics, run.agent_id, classified);
    return [classified];
  });

  const totals = classifiedRuns.reduce(
    (acc, run) => {
      acc.runs += 1;
      acc.usageRuns += run.provider_tokens > 0 ? 1 : 0;
      acc.liveTokens += run.estimated_prompt_tokens ?? 0;
      acc.providerTokens += run.provider_tokens;
      acc.resumedRuns += run.cli_session_id ? 1 : 0;
      acc.noProgressRuns +=
        run.visible_message_emitted === 0 && run.progressed === 0 && run.failed === 0 ? 1 : 0;
      acc.failedOutcomes += run.failed === 1 ? 1 : 0;
      acc.missionUpdates += run.mission_updates ?? 0;
      acc.missionReceipts += run.mission_receipts ?? 0;
      acc.missionReconciliations += run.mission_reconciliations ?? 0;
      acc.collaborationNotes += run.collaboration_notes ?? 0;
      return acc;
    },
    {
      runs: 0,
      usageRuns: 0,
      liveTokens: 0,
      providerTokens: 0,
      resumedRuns: 0,
      noProgressRuns: 0,
      failedOutcomes: 0,
      missionUpdates: 0,
      missionReceipts: 0,
      missionReconciliations: 0,
      collaborationNotes: 0,
    },
  );

  const normalAndMaintenance = classifiedRuns.filter(
    (run) => run.run_kind === 'normal.turn' || run.run_kind === 'maintenance.compaction',
  );
  const normalMaintenanceProviderTokens = normalAndMaintenance.reduce(
    (sum, run) => sum + run.provider_tokens,
    0,
  );
  const workflowRepairProviderTokens =
    kindMetrics.get('workflow.repair')?.providerTokens ?? 0;

  return {
    generatedAt: Date.now(),
    db: args.db,
    room: args.room,
    since: args.since,
    until: args.until,
    outcomeHasRunKind,
    taskCount: taskIds.size,
    totals,
    normalMaintenanceProviderTokens,
    workflowRepairProviderTokens,
    kind: sortedMetrics(kindMetrics),
    roleSession: sortedMetrics(roleSessionMetrics),
    agents: sortedMetrics(agentMetrics),
  };
}

function renderMarkdown(result) {
  const totalProvider = result.totals.providerTokens;
  const headers = [
    'Bucket',
    'Runs',
    'Usage runs',
    'Live tokens',
    'Provider tokens',
    'Provider/live',
    'Provider share',
    'Resumed',
    'No visible + no progress',
  ];

  const runKindNote = result.outcomeHasRunKind
    ? 'Persisted `run_kind` values are preferred; heuristic fallback covers legacy rows without a value.'
    : 'Current DB rows do not yet persist `run_kind`; this script detects the column and will prefer it after Lane 2 instrumentation lands.';

  return `# Run-kind Baseline

- Generated: ${iso(result.generatedAt)}
- Database: \`${result.db}\`
- Room: \`${result.room}\`
- Window: ${iso(result.since)} to ${iso(result.until)}
- Persisted \`run_kind\` column present: ${result.outcomeHasRunKind ? 'yes' : 'no'}
- Classification mode: ${result.outcomeHasRunKind ? 'persisted run_kind with heuristic fallback' : 'heuristic fallback'}
- Usage aggregation: max non-quota \`usedTokens\` per run from \`agent_run_actions.context_usage_json\`
- Prompt hygiene: stored prompts and message text are used only for boolean classification and are not emitted

## Totals

- Runs: ${number(result.totals.runs)}
- Tasks represented: ${number(result.taskCount)}
- Usage runs: ${number(result.totals.usageRuns)}
- Live prompt tokens: ${number(result.totals.liveTokens)}
- Provider tokens: ${number(result.totals.providerTokens)}
- Provider/live ratio: ${ratio(result.totals.providerTokens, result.totals.liveTokens)}
- Normal + maintenance provider baseline: ${number(result.normalMaintenanceProviderTokens)}
- Workflow repair provider tokens: ${number(result.workflowRepairProviderTokens)}

## By run kind

${markdownTable(headers, result.kind.map((metric) => metricRow(metric, totalProvider)))}

## By role and session

${markdownTable(headers, result.roleSession.map((metric) => metricRow(metric, totalProvider)))}

## By agent

${markdownTable(headers, result.agents.map((metric) => metricRow(metric, totalProvider)))}

## Fidelity baseline

- No visible + no progress turns: ${number(result.totals.noProgressRuns)} (${pct(result.totals.noProgressRuns, result.totals.runs)})
- Failed outcomes: ${number(result.totals.failedOutcomes)}
- Mission updates: ${number(result.totals.missionUpdates)}
- Mission receipts: ${number(result.totals.missionReceipts)}
- Mission reconciliations: ${number(result.totals.missionReconciliations)}
- Collaboration notes: ${number(result.totals.collaborationNotes)}

## Implementation notes

- ${runKindNote}
- \`maintenance.compaction\` is classified from exact \`/compact\` run prompts.
- \`workflow.repair\` is classified from system-triggered workflow repair messages.
- \`post-reset.first-turn\` cannot be inferred reliably before lead-reset instrumentation writes it explicitly.
`;
}

const args = parseArgs(process.argv.slice(2));
const root = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(root, '..', args.db);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const result = collect(db, { ...args, db: path.relative(path.resolve(root, '..'), dbPath) });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderMarkdown(result));
  }
} finally {
  db.close();
}
