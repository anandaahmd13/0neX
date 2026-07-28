// 0neX — mock real-time log stream server (WebSocket).
//
// Backend demo buat fitur real-time log streaming. Nge-push baris log
// bergaya orchestrator ke tiap client yang konek, mensimulasikan run
// agent yang lagi jalan. Frontend (useLogStream) konek ke sini; kalau
// server ini nggak jalan, frontend otomatis fallback ke simulasi lokal.
//
// Jalankan: pnpm ws   (atau: node server/log-stream.mjs)

import { WebSocketServer } from 'ws'

const PORT = Number(process.env.WS_PORT ?? 8787)

const AGENTS = ['Researcher', 'Coder', 'Planner', 'Data Analyst', 'Writer']

const LINES = [
  { level: 'info', message: 'Run diterima — inisialisasi konteks' },
  { level: 'info', message: 'Memanggil tool: web_search' },
  { level: 'debug', message: 'Menerima 8 hasil, memfilter relevansi' },
  { level: 'info', message: 'Menyusun konteks dari 5 sumber teratas' },
  { level: 'info', message: 'Memanggil model — streaming completion' },
  { level: 'debug', message: 'Token streamed: 1.240 (batch 3)' },
  { level: 'warn', message: 'Rate limit 82% — throttling ringan' },
  { level: 'info', message: 'Validasi output terhadap schema — OK' },
  { level: 'info', message: 'Menulis artefak ke penyimpanan sementara' },
  { level: 'info', message: 'Langkah selesai — melanjutkan pipeline' },
]

function ts() {
  return new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (socket) => {
  console.log(`[0neX-ws] client connected (${wss.clients.size} total)`)

  socket.send(
    JSON.stringify({
      ts: ts(),
      level: 'info',
      agent: 'Orchestrator',
      message: 'Terhubung ke stream log real-time',
    }),
  )

  let i = 0
  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return
    const base = LINES[i % LINES.length]
    i++
    socket.send(
      JSON.stringify({ ts: ts(), agent: pick(AGENTS), ...base }),
    )
  }, 1200)

  socket.on('close', () => {
    clearInterval(timer)
    console.log(`[0neX-ws] client disconnected (${wss.clients.size} left)`)
  })

  socket.on('error', () => clearInterval(timer))
})

console.log(`[0neX-ws] log stream server listening on ws://localhost:${PORT}`)
