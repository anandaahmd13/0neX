import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import { Card, CardHeader, CardBody } from '../components/ui/Card'
import { StatCard } from '../components/ui/StatCard'
import { AgentStatusBadge, RunStatusBadge } from '../components/ui/Badge'
import { PulseIcon, TokenIcon, AgentsIcon, CheckIcon } from '../components/icons'
import {
  globalStats,
  requestsOverTime,
  topByTokens,
  topByRequests,
  runs,
  agents,
} from '../data/mock'
import { fmtCompact, fmtInt, fmtTime, fmtDuration } from '../lib/format'
import { PageTitle } from '../components/PageTitle'

export function Dashboard() {
  const recentRuns = runs.slice(0, 4)

  return (
    <div className="space-y-6">
      <PageTitle
        title="Dashboard"
        subtitle="Ringkasan orkestrasi agent lo, real-time."
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Total Request"
          value={fmtInt(globalStats.totalRequests)}
          hint="+8.2% dari kemarin"
          icon={<PulseIcon />}
          accent="sky"
        />
        <StatCard
          label="Token Terpakai"
          value={fmtCompact(globalStats.tokensUsed)}
          hint="lintas semua agent"
          icon={<TokenIcon />}
          accent="mustard"
        />
        <StatCard
          label="Agent Aktif"
          value={`${globalStats.activeAgents}/${globalStats.totalAgents}`}
          hint="3 idle/paused/error"
          icon={<AgentsIcon />}
          accent="ok"
        />
        <StatCard
          label="Success Rate"
          value={`${globalStats.successRate}%`}
          hint={`${globalStats.runsToday} run hari ini`}
          icon={<CheckIcon />}
          accent="mustard"
        />
      </div>

      {/* Chart */}
      <Card>
        <CardHeader title="Request dari waktu ke waktu" />
        <CardBody>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={requestsOverTime}
                margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
              >
                <defs>
                  <linearGradient id="fillReq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#faae2a" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#faae2a" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1a1a1a" strokeOpacity={0.08} vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fontFamily: 'IBM Plex Mono', fill: '#1a1a1a' }}
                  tickLine={false}
                  axisLine={{ stroke: '#1a1a1a', strokeWidth: 2 }}
                  interval={2}
                />
                <YAxis
                  tick={{ fontSize: 11, fontFamily: 'IBM Plex Mono', fill: '#1a1a1a' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => fmtCompact(v)}
                />
                <Tooltip
                  contentStyle={{
                    border: '2px solid #1a1a1a',
                    borderRadius: 8,
                    fontFamily: 'IBM Plex Mono',
                    fontSize: 12,
                    boxShadow: '4px 4px 0 0 #1a1a1a',
                    background: '#fff',
                  }}
                  cursor={{ stroke: '#1a1a1a', strokeWidth: 1, strokeDasharray: '4 4' }}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#1a1a1a"
                  strokeWidth={2.5}
                  fill="url(#fillReq)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      {/* Leaderboards */}
      <div>
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink/60">
          Agent Teratas
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Leaderboard
            title="Berdasarkan Token"
            rows={topByTokens.map((a) => ({
              name: a.name,
              value: fmtCompact(a.tokensUsed),
            }))}
          />
          <Leaderboard
            title="Berdasarkan Request"
            rows={topByRequests.map((a) => ({
              name: a.name,
              value: fmtInt(a.requests),
            }))}
          />
        </div>
      </div>

      {/* Recent runs + agent snapshot */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Run terbaru" />
          <div className="divide-y-2 divide-ink">
            {recentRuns.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{r.task}</div>
                  <div className="mt-0.5 text-xs text-ink/50">
                    {r.workflow} · {fmtTime(r.startedAt)} · {fmtDuration(r.durationMs)}
                  </div>
                </div>
                <RunStatusBadge status={r.status} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Status agent" />
          <div className="divide-y-2 divide-ink">
            {agents.slice(0, 5).map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-2 px-4 py-3"
              >
                <span className="truncate text-sm font-semibold">{a.name}</span>
                <AgentStatusBadge status={a.status} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}

function Leaderboard({
  title,
  rows,
}: {
  title: string
  rows: { name: string; value: string }[]
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="divide-y-2 divide-ink">
        {rows.map((row, i) => (
          <div key={row.name} className="flex items-center gap-3 px-4 py-2.5">
            <span
              className={
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-ink text-xs font-bold ' +
                (i % 2 === 0 ? 'bg-mustard' : 'bg-sky')
              }
            >
              {i + 1}
            </span>
            <span className="flex-1 truncate text-sm font-semibold">{row.name}</span>
            <span className="text-sm tabular-nums text-ink/70">{row.value}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}
