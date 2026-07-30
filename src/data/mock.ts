import type {
  Agent,
  Run,
  Workflow,
  TimePoint,
} from '../types'

// ─── Agents ───────────────────────────────────────────────────────────────

export const agents: Agent[] = [
  {
    id: 'agt_researcher',
    name: 'Researcher',
    role: 'Web research & synthesis',
    model: 'claude-opus-4.8',
    status: 'active',
    description:
      'Menjelajah web, mengumpulkan sumber, dan merangkum temuan jadi brief singkat.',
    providerId: 'claude-cli',
    systemPrompt: 'Ikuti role agent dengan teliti. Berikan hasil yang ringkas, akurat, dan dapat ditindaklanjuti.',
    toolPolicy: 'standard',
    tools: ['web_search', 'web_extract', 'browser'],
    tokensUsed: 8_420_000,
    requests: 1284,
    successRate: 98.2,
    avgLatencyMs: 3120,
    createdAt: '2026-05-02',
  },
  {
    id: 'agt_coder',
    name: 'Coder',
    role: 'Code generation & PR',
    model: 'claude-opus-4.8',
    status: 'active',
    description:
      'Nulis, refactor, dan review kode. Bisa buka PR langsung ke repo.',
    providerId: 'claude-cli',
    systemPrompt: 'Ikuti role agent dengan teliti. Berikan hasil yang ringkas, akurat, dan dapat ditindaklanjuti.',
    toolPolicy: 'standard',
    tools: ['terminal', 'file', 'github', 'code_exec'],
    tokensUsed: 12_930_000,
    requests: 2041,
    successRate: 95.7,
    avgLatencyMs: 5240,
    createdAt: '2026-05-02',
  },
  {
    id: 'agt_planner',
    name: 'Planner',
    role: 'Task decomposition',
    model: 'claude-sonnet-4',
    status: 'idle',
    description:
      'Memecah goal besar jadi langkah-langkah kecil dan nge-assign ke agent lain.',
    providerId: 'claude-cli',
    systemPrompt: 'Ikuti role agent dengan teliti. Berikan hasil yang ringkas, akurat, dan dapat ditindaklanjuti.',
    toolPolicy: 'standard',
    tools: ['delegation', 'todo'],
    tokensUsed: 3_110_000,
    requests: 512,
    successRate: 99.1,
    avgLatencyMs: 1870,
    createdAt: '2026-05-10',
  },
  {
    id: 'agt_analyst',
    name: 'Data Analyst',
    role: 'Data crunching & charts',
    model: 'claude-sonnet-4',
    status: 'active',
    description:
      'Analisa dataset, bikin agregasi, dan generate visualisasi dari data mentah.',
    providerId: 'claude-cli',
    systemPrompt: 'Ikuti role agent dengan teliti. Berikan hasil yang ringkas, akurat, dan dapat ditindaklanjuti.',
    toolPolicy: 'standard',
    tools: ['code_exec', 'file'],
    tokensUsed: 6_740_000,
    requests: 903,
    successRate: 97.4,
    avgLatencyMs: 4010,
    createdAt: '2026-05-18',
  },
  {
    id: 'agt_writer',
    name: 'Writer',
    role: 'Content & docs',
    model: 'claude-opus-4.8',
    status: 'paused',
    description:
      'Nulis artikel, dokumentasi, dan copy dengan tone yang bisa diatur.',
    providerId: 'claude-cli',
    systemPrompt: 'Ikuti role agent dengan teliti. Berikan hasil yang ringkas, akurat, dan dapat ditindaklanjuti.',
    toolPolicy: 'standard',
    tools: ['web_search', 'file'],
    tokensUsed: 4_980_000,
    requests: 671,
    successRate: 96.0,
    avgLatencyMs: 2890,
    createdAt: '2026-06-01',
  },
  {
    id: 'agt_ops',
    name: 'Ops Sentinel',
    role: 'Monitoring & alerts',
    model: 'claude-haiku-4',
    status: 'error',
    description:
      'Ngawasin health service, kirim alert kalau ada anomali. Lagi ada gangguan koneksi.',
    providerId: 'claude-cli',
    systemPrompt: 'Ikuti role agent dengan teliti. Berikan hasil yang ringkas, akurat, dan dapat ditindaklanjuti.',
    toolPolicy: 'standard',
    tools: ['terminal', 'web_extract'],
    tokensUsed: 1_240_000,
    requests: 4820,
    successRate: 89.3,
    avgLatencyMs: 640,
    createdAt: '2026-06-14',
  },
  {
    id: 'agt_kiro',
    name: 'Kiro Assistant',
    role: 'Agentic coding assistant',
    model: '',
    status: 'active',
    description:
      'Asisten agentic Kiro via ACP dengan workspace, sesi persisten, permission interaktif, dan MCP server pilihan lo.',
    providerId: 'kiro-agent',
    systemPrompt: 'Bantu kerja di workspace secara aman. Jelaskan aksi penting dan minta permission saat dibutuhkan.',
    toolPolicy: 'standard',
    tools: ['workspace', 'terminal', 'file', 'mcp'],
    tokensUsed: 0,
    requests: 0,
    successRate: 100,
    avgLatencyMs: 0,
    createdAt: '2026-07-29',
  },
  {
    id: 'agt_kiro_inference',
    name: 'Kiro HTTPS',
    role: 'Legacy inference assistant',
    model: '',
    status: 'active',
    description:
      'Inference stateless lewat Kiro HTTPS dengan credential connection dan model tersimpan.',
    providerId: 'kiro-cli',
    systemPrompt: 'Berikan jawaban yang ringkas, akurat, dan dapat ditindaklanjuti.',
    toolPolicy: 'none',
    tools: [],
    tokensUsed: 0,
    requests: 0,
    successRate: 100,
    avgLatencyMs: 0,
    createdAt: '2026-07-29',
  },
]

// ─── Workflows ────────────────────────────────────────────────────────────

export const workflows: Workflow[] = [
  {
    id: 'wf_research_report',
    name: 'Research → Report',
    description:
      'Trigger topik, Researcher kumpulin sumber, Writer susun laporan, output ke Markdown.',
    runs: 342,
    lastRun: '2026-07-27T08:12:00',
    nodes: [
      { id: 'n1', kind: 'trigger', label: 'Topic Input', sublabel: 'manual / webhook', x: 40, y: 160 },
      { id: 'n2', kind: 'agent', label: 'Researcher', sublabel: 'claude-opus-4.8', x: 280, y: 80 },
      { id: 'n3', kind: 'tool', label: 'web_search', sublabel: 'tool call', x: 280, y: 260 },
      { id: 'n4', kind: 'agent', label: 'Writer', sublabel: 'claude-opus-4.8', x: 540, y: 160 },
      { id: 'n5', kind: 'output', label: 'Report.md', sublabel: 'markdown', x: 800, y: 160 },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n2' },
      { from: 'n2', to: 'n4' },
      { from: 'n4', to: 'n5' },
    ],
  },
  {
    id: 'wf_auto_pr',
    name: 'Auto PR Pipeline',
    description:
      'Planner pecah task, Coder implement, jalanin test, buka PR otomatis.',
    runs: 128,
    lastRun: '2026-07-27T06:45:00',
    nodes: [
      { id: 'n1', kind: 'trigger', label: 'Issue', sublabel: 'github webhook', x: 40, y: 160 },
      { id: 'n2', kind: 'agent', label: 'Planner', sublabel: 'claude-sonnet-4', x: 280, y: 160 },
      { id: 'n3', kind: 'agent', label: 'Coder', sublabel: 'claude-opus-4.8', x: 540, y: 80 },
      { id: 'n4', kind: 'tool', label: 'run tests', sublabel: 'code_exec', x: 540, y: 260 },
      { id: 'n5', kind: 'output', label: 'Open PR', sublabel: 'github', x: 800, y: 160 },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n4' },
      { from: 'n4', to: 'n5' },
    ],
  },
  {
    id: 'wf_data_digest',
    name: 'Daily Data Digest',
    description:
      'Tiap pagi tarik data, Analyst crunch, kirim ringkasan + chart ke Telegram.',
    runs: 210,
    lastRun: '2026-07-27T05:00:00',
    nodes: [
      { id: 'n1', kind: 'trigger', label: 'Cron 05:00', sublabel: 'schedule', x: 40, y: 160 },
      { id: 'n2', kind: 'tool', label: 'fetch data', sublabel: 'web_extract', x: 280, y: 160 },
      { id: 'n3', kind: 'agent', label: 'Data Analyst', sublabel: 'claude-sonnet-4', x: 540, y: 160 },
      { id: 'n4', kind: 'output', label: 'Telegram', sublabel: 'message', x: 800, y: 160 },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n4' },
    ],
  },
]

// ─── Runs ─────────────────────────────────────────────────────────────────

export const runs: Run[] = [
  {
    id: 'run_9f2a',
    task: 'Riset tren LLM open-source Q3 2026',
    workflow: 'Research → Report',
    status: 'running',
    startedAt: '2026-07-27T09:14:22',
    durationMs: 42_000,
    tokensUsed: 128_400,
    agentsInvolved: ['Researcher', 'Writer'],
    output: '',
    logs: [
      { ts: '09:14:22', level: 'info', agent: 'Researcher', message: 'Run dimulai — task diterima' },
      { ts: '09:14:25', level: 'info', agent: 'Researcher', message: 'web_search: "open source LLM leaderboard 2026"' },
      { ts: '09:14:31', level: 'debug', agent: 'Researcher', message: '12 sumber ditemukan, filtering relevansi' },
      { ts: '09:14:48', level: 'info', agent: 'Researcher', message: 'Menyusun brief dari 7 sumber teratas' },
      { ts: '09:15:02', level: 'warn', agent: 'Writer', message: 'Menunggu output Researcher selesai' },
    ],
  },
  {
    id: 'run_7c1b',
    task: 'Fix bug pagination di /users endpoint',
    workflow: 'Auto PR Pipeline',
    status: 'success',
    startedAt: '2026-07-27T06:45:10',
    durationMs: 184_000,
    tokensUsed: 342_100,
    agentsInvolved: ['Planner', 'Coder'],
    output:
      'PR #482 dibuka: "fix: add limit/offset to /users". 3 file diubah, 8 test lulus.',
    logs: [
      { ts: '06:45:10', level: 'info', agent: 'Planner', message: 'Memecah issue jadi 3 subtask' },
      { ts: '06:45:40', level: 'info', agent: 'Coder', message: 'Edit query layer: tambah limit/offset' },
      { ts: '06:47:12', level: 'info', agent: 'Coder', message: 'run tests: 8 passed' },
      { ts: '06:48:14', level: 'info', agent: 'Coder', message: 'PR #482 dibuka ke branch main' },
    ],
  },
  {
    id: 'run_5e88',
    task: 'Digest data penjualan harian',
    workflow: 'Daily Data Digest',
    status: 'success',
    startedAt: '2026-07-27T05:00:03',
    durationMs: 61_000,
    tokensUsed: 88_700,
    agentsInvolved: ['Data Analyst'],
    output: 'Digest terkirim ke Telegram: revenue +12.4% WoW, 3 chart terlampir.',
    logs: [
      { ts: '05:00:03', level: 'info', agent: 'Data Analyst', message: 'Menarik dataset harian (14.2k rows)' },
      { ts: '05:00:31', level: 'info', agent: 'Data Analyst', message: 'Agregasi + generate 3 chart' },
      { ts: '05:01:04', level: 'info', agent: 'Data Analyst', message: 'Kirim ke Telegram — sukses' },
    ],
  },
  {
    id: 'run_3d40',
    task: 'Monitoring uptime service malam',
    workflow: 'Daily Data Digest',
    status: 'failed',
    startedAt: '2026-07-27T02:30:00',
    durationMs: 12_000,
    tokensUsed: 4_200,
    agentsInvolved: ['Ops Sentinel'],
    output: 'Run gagal: koneksi ke endzpoint monitoring timeout setelah 3x retry.',
    logs: [
      { ts: '02:30:00', level: 'info', agent: 'Ops Sentinel', message: 'Cek health 6 service' },
      { ts: '02:30:08', level: 'warn', agent: 'Ops Sentinel', message: 'Service #4 lambat merespon' },
      { ts: '02:30:12', level: 'error', agent: 'Ops Sentinel', message: 'Timeout — gagal setelah 3 retry' },
    ],
  },
  {
    id: 'run_1a09',
    task: 'Draft artikel "Panduan RAG 2026"',
    workflow: 'Research → Report',
    status: 'queued',
    startedAt: '2026-07-27T09:20:00',
    durationMs: 0,
    tokensUsed: 0,
    agentsInvolved: ['Researcher', 'Writer'],
    output: '',
    logs: [
      { ts: '09:20:00', level: 'info', agent: 'Planner', message: 'Run masuk antrian — menunggu slot' },
    ],
  },
]

// ─── Time series (dashboard chart) ──────────────────────────────────────────

export const requestsOverTime: TimePoint[] = [
  { label: '28 Jun', value: 1240 },
  { label: '30 Jun', value: 1580 },
  { label: '02 Jul', value: 1390 },
  { label: '04 Jul', value: 1820 },
  { label: '06 Jul', value: 2110 },
  { label: '08 Jul', value: 1980 },
  { label: '10 Jul', value: 2340 },
  { label: '12 Jul', value: 2620 },
  { label: '14 Jul', value: 2410 },
  { label: '16 Jul', value: 2890 },
  { label: '18 Jul', value: 3120 },
  { label: '20 Jul', value: 2970 },
  { label: '22 Jul', value: 3340 },
  { label: '24 Jul', value: 3610 },
  { label: '26 Jul', value: 3920 },
  { label: '27 Jul', value: 4180 },
]

// ─── Aggregate stats ─────────────────────────────────────────────────────────

export const globalStats = {
  totalRequests: 10_231,
  tokensUsed: 37_420_000,
  activeAgents: agents.filter((a) => a.status === 'active').length,
  totalAgents: agents.length,
  successRate: 96.4,
  runsToday: 48,
}

// Leaderboard derived from agents
export const topByTokens = [...agents]
  .sort((a, b) => b.tokensUsed - a.tokensUsed)
  .slice(0, 5)

export const topByRequests = [...agents]
  .sort((a, b) => b.requests - a.requests)
  .slice(0, 5)
