#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOM_ID = '5YZGXgDK6e5M';
const DEFAULT_BASELINE_SINCE = '2026-05-07T00:26:47.019Z';
const DEFAULT_MIN_REDUCTION = 25;
const DEFAULT_SINCE_HOURS = 24;

const BASELINE = {
  label: 'pre-source-edit run-kind baseline',
  generatedAt: '2026-05-07T01:15:10.097Z',
  room: DEFAULT_ROOM_ID,
  normalMaintenanceProviderTokens: 9257296,
  allProviderTokens: 9557288,
  normalTurnRuns: 49,
  normalTurnLiveTokens: 187424,
  noProgressRate: 25 / 71,
  failedOutcomes: 0,
  workflowRepairRate: 5 / 71,
  missionReceiptRate: 37 / 71,
};

function usage() {
  console.log(`Usage: node scripts/verify-token-savings-gate.mjs [options]

Options:
  --db <path>               SQLite DB path (default: data/fireside.sqlite)
  --room <id>               Room id (default: ${DEFAULT_ROOM_ID})
  --since <iso|ms>          Inclusive post-change lower bound
  --until <iso|ms>          Exclusive post-change upper bound (default: now)
  --since-hours <n>         Use now - n hours when --since is omitted (default: ${DEFAULT_SINCE_HOURS})
  --min-reduction <pct>     Required reduction percent (default: ${DEFAULT_MIN_REDUCTION})
  --json                    Print JSON instead of markdown
  --help                    Show this message
`);
}

function parseArgs(argv) {
  const args = {
    db: 'data/fireside.sqlite',
    room: DEFAULT_ROOM_ID,
    since: null,
    sinceHours: DEFAULT_SINCE_HOURS,
    until: Date.now(),
    minReduction: DEFAULT_MIN_REDUCTION,
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
    if (!next) throw new Error(`Missing value for ${arg}`);
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
    if (arg === '--since-hours') {
      args.sinceHours = Number(next);
      i += 1;
      continue;
    }
    if (arg === '--min-reduction') {
      args.minReduction = Number(next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isFinite(args.until)) throw new Error('Invalid --until value');
  if (args.since === null) {
    if (!Number.isFinite(args.sinceHours) || args.sinceHours <= 0) {
      throw new Error('Invalid --since-hours value');
    }
    args.since = args.until - args.sinceHours * 60 * 60 * 1000;
  }
  if (!Number.isFinite(args.since) || args.until <= args.since) {
    throw new Error('Invalid time window');
  }
  if (!Number.isFinite(args.minReduction) || args.minReduction < 0 || args.minReduction > 100) {
    throw new Error('Invalid --min-reduction value');
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

function iso(ms) {
  return new Date(ms).toISOString();
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function number(value) {
  return Math.round(value).toLocaleString('en-US');
}

function ratio(value) {
  return `${value.toFixed(2)}x`;
}

function findMetric(metrics, key) {
  return metrics.find((metric) => metric.key === key) ?? null;
}

function reductionPercent(baseline, current) {
  if (!baseline) return 0;
  return ((baseline - current) / baseline) * 100;
}

function runMeasurement(args) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const measureScript = path.join(root, 'scripts', 'measure-run-kind-baseline.mjs');
  const stdout = execFileSync(
    process.execPath,
    [
      measureScript,
      '--db',
      args.db,
      '--room',
      args.room,
      '--since',
      String(args.since),
      '--until',
      String(args.until),
      '--json',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

function evaluate(measurement, args) {
  const normal = findMetric(measurement.kind, 'normal.turn');
  const maintenance = findMetric(measurement.kind, 'maintenance.compaction');
  const workflowRepair = findMetric(measurement.kind, 'workflow.repair');
  const postReset = findMetric(measurement.kind, 'post-reset.first-turn');

  const normalMaintenanceProviderTokens =
    (normal?.providerTokens ?? 0) + (maintenance?.providerTokens ?? 0);
  const normalTurnRuns = normal?.runs ?? 0;
  const normalTurnLiveTokens = normal?.liveTokens ?? 0;

  const baselineCostPerNormalRun =
    BASELINE.normalMaintenanceProviderTokens / BASELINE.normalTurnRuns;
  const currentCostPerNormalRun = normalTurnRuns
    ? normalMaintenanceProviderTokens / normalTurnRuns
    : Infinity;

  const baselineCostPerNormalLiveToken =
    BASELINE.normalMaintenanceProviderTokens / BASELINE.normalTurnLiveTokens;
  const currentCostPerNormalLiveToken = normalTurnLiveTokens
    ? normalMaintenanceProviderTokens / normalTurnLiveTokens
    : Infinity;

  const perRunReduction = reductionPercent(baselineCostPerNormalRun, currentCostPerNormalRun);
  const perLiveReduction = reductionPercent(
    baselineCostPerNormalLiveToken,
    currentCostPerNormalLiveToken,
  );

  const noProgressRate = measurement.totals.runs
    ? measurement.totals.noProgressRuns / measurement.totals.runs
    : 0;
  const workflowRepairRate = measurement.totals.runs
    ? (workflowRepair?.runs ?? 0) / measurement.totals.runs
    : 0;
  const missionReceiptRate = measurement.totals.runs
    ? measurement.totals.missionReceipts / measurement.totals.runs
    : 0;

  const windowHours = (measurement.until - measurement.since) / 60 / 60 / 1000;
  const enoughWindow = windowHours >= 23;
  const enoughTraffic = normalTurnRuns >= 20;

  const guards = [
    {
      name: 'normal+maintenance cost per normal turn',
      pass: perRunReduction >= args.minReduction,
      value: `${perRunReduction.toFixed(1)}% reduction`,
      baseline: `${number(Math.round(baselineCostPerNormalRun))} provider/run`,
      current: `${number(Math.round(currentCostPerNormalRun))} provider/run`,
    },
    {
      name: 'normal+maintenance cost per normal live token',
      pass: perLiveReduction >= args.minReduction,
      value: `${perLiveReduction.toFixed(1)}% reduction`,
      baseline: ratio(baselineCostPerNormalLiveToken),
      current: ratio(currentCostPerNormalLiveToken),
    },
    {
      name: 'no visible + no progress rate',
      pass: noProgressRate <= BASELINE.noProgressRate,
      value: pct(noProgressRate),
      baseline: pct(BASELINE.noProgressRate),
      current: pct(noProgressRate),
    },
    {
      name: 'failed outcomes',
      pass: measurement.totals.failedOutcomes <= BASELINE.failedOutcomes,
      value: number(measurement.totals.failedOutcomes),
      baseline: number(BASELINE.failedOutcomes),
      current: number(measurement.totals.failedOutcomes),
    },
    {
      name: 'workflow repair rate',
      pass: workflowRepairRate <= BASELINE.workflowRepairRate,
      value: pct(workflowRepairRate),
      baseline: pct(BASELINE.workflowRepairRate),
      current: pct(workflowRepairRate),
    },
    {
      name: 'mission receipt count per turn',
      pass: missionReceiptRate >= BASELINE.missionReceiptRate,
      value: pct(missionReceiptRate),
      baseline: pct(BASELINE.missionReceiptRate),
      current: pct(missionReceiptRate),
    },
  ];

  const pass = enoughWindow && enoughTraffic && guards.every((guard) => guard.pass);
  return {
    baseline: BASELINE,
    generatedAt: Date.now(),
    room: args.room,
    since: measurement.since,
    until: measurement.until,
    windowHours,
    enoughWindow,
    enoughTraffic,
    minReduction: args.minReduction,
    pass,
    normalMaintenanceProviderTokens,
    allProviderTokens: measurement.totals.providerTokens,
    normalTurnRuns,
    normalTurnLiveTokens,
    postResetFirstTurnRuns: postReset?.runs ?? 0,
    postResetFirstTurnProviderTokens: postReset?.providerTokens ?? 0,
    guards,
    measurement,
  };
}

function renderMarkdown(result) {
  const guardRows = result.guards
    .map(
      (guard) =>
        `| ${guard.name} | ${guard.pass ? 'pass' : 'fail'} | ${guard.baseline} | ${guard.current} | ${guard.value} |`,
    )
    .join('\n');

  return `# Token Savings Verification Gate

- Generated: ${iso(result.generatedAt)}
- Room: \`${result.room}\`
- Window: ${iso(result.since)} to ${iso(result.until)} (${result.windowHours.toFixed(2)}h)
- Required reduction: ${result.minReduction.toFixed(1)}%
- Gate result: ${result.pass ? 'PASS' : 'NOT PASSED'}
- 24h window ready: ${result.enoughWindow ? 'yes' : 'no'}
- Traffic floor ready: ${result.enoughTraffic ? 'yes' : 'no'}

## Provider spend

- Current all-provider tokens: ${number(result.allProviderTokens)}
- Current normal+maintenance provider tokens: ${number(result.normalMaintenanceProviderTokens)}
- Current normal turns: ${number(result.normalTurnRuns)}
- Current normal live tokens: ${number(result.normalTurnLiveTokens)}
- Current post-reset first turns: ${number(result.postResetFirstTurnRuns)}
- Current post-reset first-turn provider tokens: ${number(result.postResetFirstTurnProviderTokens)}

## Guards

| Guard | Result | Baseline | Current | Value |
| --- | --- | ---: | ---: | ---: |
${guardRows}

## Notes

- This gate intentionally normalizes normal+maintenance cost by normal-turn volume and live prompt
  tokens because a 24h soak will not have the same traffic volume as the pre-source-edit slice.
- Fidelity failures veto savings wins. A cheaper run that increases repairs, no-progress turns, or
  receipt loss is not a pass.
- \`post-reset.first-turn\` remains informational until Lane 2 writes persisted run kinds.
`;
}

const args = parseArgs(process.argv.slice(2));
const measurement = runMeasurement(args);
const result = evaluate(measurement, args);
if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(renderMarkdown(result));
}
