/* =============================================================================
   Better Trigger — mock data, typed. Previously attached to window.BT_DATA;
   now plain ES module exports.
   ============================================================================= */
import type {
  Task,
  Run,
  RunStatus,
  Trace,
  LogLine,
  Schedule,
  Alert,
  Deployment,
} from '../types';

// ---- Tasks (defined in code) ----
export const TASKS: Task[] = [
  { id: 'process-order',      name: 'process-order',      file: 'trigger/orders.ts',      runs24h: 1840, p50: '2.1s', p95: '6.4s', success: 99.4, trend: [4, 6, 5, 8, 7, 9, 12, 10, 8, 11, 14, 13] },
  { id: 'send-receipt',       name: 'send-receipt',       file: 'trigger/email.ts',       runs24h: 1792, p50: '640ms', p95: '1.9s', success: 99.9, trend: [3, 4, 4, 5, 6, 5, 7, 8, 7, 9, 8, 10] },
  { id: 'sync-inventory',     name: 'sync-inventory',     file: 'trigger/inventory.ts',   runs24h: 288,  p50: '4.8s', p95: '18s',  success: 96.1, trend: [2, 3, 2, 4, 3, 5, 4, 3, 6, 5, 7, 6] },
  { id: 'generate-thumbnail', name: 'generate-thumbnail', file: 'trigger/media.ts',       runs24h: 612,  p50: '3.3s', p95: '9.1s', success: 98.2, trend: [5, 4, 6, 5, 7, 6, 8, 7, 9, 8, 7, 9] },
  { id: 'weekly-digest',      name: 'weekly-digest',      file: 'trigger/digests.ts',     runs24h: 12,   p50: '22s',  p95: '41s',  success: 100,  trend: [1, 0, 1, 2, 1, 0, 1, 1, 2, 1, 0, 1] },
  { id: 'reindex-search',     name: 'reindex-search',     file: 'trigger/search.ts',      runs24h: 48,   p50: '9.4s', p95: '26s',  success: 93.7, trend: [2, 1, 3, 2, 4, 3, 2, 5, 3, 4, 3, 5] },
];

const STATUSES: RunStatus[] = ['success', 'running', 'failed', 'queued', 'success', 'success'];
const TRIGGERS = ['event', 'schedule', 'api', 'event', 'api'];

// ---- Runs list ----
function mkRun(i: number): Run {
  const task = TASKS[i % TASKS.length];
  const status: RunStatus = i === 0 ? 'running' : STATUSES[i % STATUSES.length];
  const mins = i * 7 + (i % 3) * 2;
  return {
    id: 'run_' + (74910 - i).toString(36) + 'k' + (i % 9),
    task: task.name,
    status,
    version: '20260530.3',
    env: i % 5 === 0 ? 'staging' : 'prod',
    trigger: TRIGGERS[i % TRIGGERS.length],
    duration: status === 'running' ? null : ['2.1s', '640ms', '4.8s', '11.2s', '3.3s', '880ms', '6.7s'][i % 7],
    attempts: status === 'failed' ? 3 : 1,
    started: mins === 0 ? 'just now' : mins < 60 ? mins + 'm ago' : Math.floor(mins / 60) + 'h ago',
    ts: mins,
  };
}
export const RUNS: Run[] = Array.from({ length: 26 }, (_, i) => mkRun(i));

// ---- Hero trace: span tree for the live run ----
// start (ms offset), dur (ms), status, level for indentation
export const TRACE: Trace = {
  runId: 'run_1k9f2k0',
  task: 'process-order',
  version: '20260530.3',
  env: 'prod',
  trigger: 'event · order.created',
  queuedFor: '120ms',
  payload: {
    orderId: 'ord_8842',
    customer: 'cus_a91',
    items: 3,
    total: 14290,
    currency: 'usd',
  },
  totalMs: 4200,
  spans: [
    { id: 's0',  label: 'process-order',          kind: 'task',  level: 0, start: 0,    dur: 4200, status: 'running' },
    { id: 's1',  label: 'validate payload',       kind: 'fn',    level: 1, start: 40,   dur: 90,   status: 'success' },
    { id: 's2',  label: 'load order from db',     kind: 'query', level: 1, start: 150,  dur: 230,  status: 'success' },
    { id: 's3',  label: 'charge-payment',         kind: 'task',  level: 1, start: 410,  dur: 1180, status: 'success' },
    { id: 's4',  label: 'stripe.charges.create',  kind: 'http',  level: 2, start: 470,  dur: 980,  status: 'success' },
    { id: 's5',  label: 'record ledger entry',    kind: 'query', level: 2, start: 1470, dur: 110,  status: 'success' },
    { id: 's6',  label: 'reserve-inventory',      kind: 'task',  level: 1, start: 1620, dur: 760,  status: 'warning' },
    { id: 's7',  label: 'lock skus',              kind: 'query', level: 2, start: 1660, dur: 180,  status: 'success' },
    { id: 's8',  label: 'warehouse.reserve',      kind: 'http',  level: 2, start: 1860, dur: 510,  status: 'warning' },
    { id: 's9',  label: 'send-receipt',           kind: 'task',  level: 1, start: 2420, dur: 690,  status: 'success' },
    { id: 's10', label: 'render template',        kind: 'fn',    level: 2, start: 2450, dur: 140,  status: 'success' },
    { id: 's11', label: 'resend.emails.send',     kind: 'http',  level: 2, start: 2610, dur: 480,  status: 'success' },
    { id: 's12', label: 'generate-thumbnail',     kind: 'task',  level: 1, start: 3140, dur: 1060, status: 'running' },
    { id: 's13', label: 'fetch source image',     kind: 'http',  level: 2, start: 3170, dur: 320,  status: 'success' },
    { id: 's14', label: 'sharp.resize',           kind: 'fn',    level: 2, start: 3510, dur: 690,  status: 'running' },
  ],
};

// Per-span log lines, streamed in the run view
export const SPAN_LOGS: Record<string, LogLine[]> = {
  s0:  [['info', 'run started', '0ms'], ['debug', 'env=prod region=us-east-1', '2ms']],
  s1:  [['debug', 'payload schema ok (3 items)', '48ms']],
  s2:  [['query', 'SELECT * FROM orders WHERE id=$1', '160ms'], ['debug', 'order loaded · 3 line items', '370ms']],
  s3:  [['info', 'charging $142.90 to cus_a91', '420ms']],
  s4:  [['http', 'POST stripe.com/v1/charges', '472ms'], ['info', 'charge ch_3Q1 succeeded', '1440ms']],
  s5:  [['query', 'INSERT INTO ledger ...', '1475ms']],
  s6:  [['info', 'reserving 3 skus', '1625ms']],
  s7:  [['query', 'SELECT ... FOR UPDATE', '1665ms']],
  s8:  [['http', 'POST warehouse/reserve', '1865ms'], ['warn', 'sku SKU-22 low stock (4 left)', '2300ms']],
  s9:  [['info', 'queuing receipt email', '2425ms']],
  s10: [['debug', 'compiled mjml → html (18kb)', '2470ms']],
  s11: [['http', 'POST resend.com/emails', '2615ms'], ['info', 'email id re_8a2 accepted', '3050ms']],
  s12: [['info', 'thumbnail job started', '3145ms']],
  s13: [['http', 'GET cdn/img/ord_8842.jpg', '3175ms']],
  s14: [['debug', 'resize 2400px → 480px webp', '3520ms']],
};

// ---- Schedules ----
export const SCHEDULES: Schedule[] = [
  { id: 'sch_1', task: 'weekly-digest',  cron: '0 9 * * 1',    human: 'Every Monday at 09:00', tz: 'America/New_York', next: 'in 2d 14h',  last: 'ok',   enabled: true },
  { id: 'sch_2', task: 'sync-inventory', cron: '*/15 * * * *', human: 'Every 15 minutes',      tz: 'UTC',              next: 'in 6m',      last: 'ok',   enabled: true },
  { id: 'sch_3', task: 'reindex-search', cron: '0 */6 * * *',  human: 'Every 6 hours',         tz: 'UTC',              next: 'in 1h 12m',  last: 'warn', enabled: true },
  { id: 'sch_4', task: 'cleanup-temp',   cron: '0 3 * * *',    human: 'Daily at 03:00',        tz: 'UTC',              next: 'in 9h 41m',  last: 'ok',   enabled: false },
];

// ---- Alerts ----
export const ALERTS: Alert[] = [
  { id: 'al_1', title: 'reindex-search failure rate > 5%', scope: 'task: reindex-search', channel: 'Slack #eng-alerts', status: 'firing',   when: '12m ago', tone: 'red' },
  { id: 'al_2', title: 'Any run exceeds 60s',              scope: 'all tasks · prod',     channel: 'Email',             status: 'armed',    when: '—',       tone: 'gray' },
  { id: 'al_3', title: 'Deployment failed',                scope: 'all environments',     channel: 'Slack #deploys',    status: 'armed',    when: '—',       tone: 'gray' },
  { id: 'al_4', title: 'sync-inventory p95 > 20s',         scope: 'task: sync-inventory', channel: 'PagerDuty',         status: 'resolved', when: '3h ago',  tone: 'green' },
];

// ---- Deployments ----
export const DEPLOYMENTS: Deployment[] = [
  { id: '20260530.3', env: 'prod',    status: 'current',  tasks: 18, when: '2h ago', git: 'a91f2c', by: 'you', msg: 'fix: retry warehouse.reserve on 5xx' },
  { id: '20260530.2', env: 'prod',    status: 'previous', tasks: 18, when: '8h ago', git: '7b3e90', by: 'you', msg: 'feat: thumbnail webp output' },
  { id: '20260530.1', env: 'staging', status: 'current',  tasks: 19, when: '9h ago', git: '1d0a4e', by: 'you', msg: 'wip: search reindex batching' },
  { id: '20260529.4', env: 'prod',    status: 'archived', tasks: 17, when: '1d ago', git: '55c8ab', by: 'you', msg: 'chore: bump sdk to 3.2' },
  { id: '20260529.1', env: 'prod',    status: 'failed',   tasks: 0,  when: '1d ago', git: 'f02b71', by: 'you', msg: 'feat: ledger entries (build failed)' },
];
