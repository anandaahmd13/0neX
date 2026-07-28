// 0neX — Claude Code bridge (WebSocket → headless `claude -p`).
//
// POC lokal: nyambungin UI ke Claude Code CLI dalam mode headless dan
// nge-stream output-nya real-time ke client. Client kirim
// { type: "run", prompt: "<teks>" }, bridge nyalain `claude -p` dan
// ngirim balik { type: "chunk" } per event, ditutup { type: "done" }.
//
// KEAMANAN — bridge ini nge-spawn Claude Code CLI, jadi setiap koneksi =
// kemampuan jalanin proses di mesin ini. Lapisan proteksi:
//   1. Bind ke 127.0.0.1 doang (HOST) — nggak kebuka ke jaringan.
//   2. Wajib token (CLAUDE_BRIDGE_TOKEN) di query `?token=` handshake.
//   3. Validasi Origin header terhadap allowlist (ALLOWED_ORIGINS).
//   4. Prompt dilewatin sebagai argumen array (bukan shell string) — aman
//      dari injection. Cuma binary "claude" + field `prompt` yang dipakai.
//
// Config lewat env:
//   WS_PORT               (default 8788)
//   WS_HOST               (default 127.0.0.1 — JANGAN 0.0.0.0 kecuali paham risikonya)
//   CLAUDE_BRIDGE_TOKEN   (default: auto-generate + print saat start)
//   ALLOWED_ORIGINS       (CSV, default: http://localhost:5199,http://127.0.0.1:5199 + dev vite umum)
//
// Jalankan: pnpm claude-bridge   (atau: node server/claude-bridge.mjs)

import { WebSocketServer } from 'ws'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env.WS_PORT ?? 8788)
// Default bind ke loopback — bridge TIDAK boleh kebuka ke jaringan tanpa sadar.
const HOST = process.env.WS_HOST ?? '127.0.0.1'

// Token wajib buat handshake. Kalau nggak di-set, auto-generate + print sekali
// biar dev tetep aman-by-default tanpa harus setup manual.
const TOKEN = process.env.CLAUDE_BRIDGE_TOKEN ?? randomBytes(24).toString('hex')
const TOKEN_AUTOGEN = !process.env.CLAUDE_BRIDGE_TOKEN

// Origin allowlist — tolak koneksi dari asal yang nggak dikenal (mis. web jahat
// yang nyoba nyambung ke bridge lokal lewat browser korban).
const DEFAULT_ORIGINS = [
  'http://localhost:5199',
  'http://127.0.0.1:5199',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ??
    DEFAULT_ORIGINS),
)

// Argumen tetap buat mode headless + streaming JSON.
const CLAUDE_ARGS = ['--output-format', 'stream-json', '--verbose']

// --- Batas robustness (semua bisa di-override lewat env) ---
// Timeout run: proses claude yang lewat batas ini di-kill paksa biar nggak
// gantung selamanya nyedot resource.
const RUN_TIMEOUT_MS = Number(process.env.CLAUDE_RUN_TIMEOUT_MS ?? 120_000)
// Batas koneksi concurrent — cegah satu aktor spawn banyak proses via reconnect.
const MAX_CLIENTS = Number(process.env.CLAUDE_MAX_CLIENTS ?? 4)
// Batas panjang prompt (char) — tolak payload gede sebelum spawn.
const MAX_PROMPT_LEN = Number(process.env.CLAUDE_MAX_PROMPT_LEN ?? 20_000)
// Jeda antara SIGTERM dan SIGKILL saat kill proces (biar sempat cleanup).
const KILL_GRACE_MS = Number(process.env.CLAUDE_KILL_GRACE_MS ?? 3_000)

/** Bandingin dua string secara constant-time biar nggak bocor lewat timing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Gate handshake WS: cek Origin + token SEBELUM koneksi di-upgrade. Return
 * true kalau boleh lanjut, atau tolak (return false) sambil nutup socket.
 */
function verifyClient({ origin, req }, done) {
  // Origin: browser selalu ngirim; tool non-browser (mis. test) boleh tanpa.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    console.warn(`[claude-bridge] tolak koneksi: origin nggak diizinkan (${origin})`)
    done(false, 403, 'Origin tidak diizinkan')
    return
  }
  // Token wajib, dikirim lewat query string `?token=...`.
  let token = ''
  try {
    token = new URL(req.url, 'http://localhost').searchParams.get('token') ?? ''
  } catch {
    token = ''
  }
  if (!safeEqual(token, TOKEN)) {
    console.warn('[claude-bridge] tolak koneksi: token salah/kosong')
    done(false, 401, 'Token tidak valid')
    return
  }
  done(true)
}

const wss = new WebSocketServer({ host: HOST, port: PORT, verifyClient })

/** Kirim objek JSON ke socket kalau masih kebuka. */
function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

/**
 * Kill proses child secara bertahap: SIGTERM dulu (biar sempat cleanup),
 * lalu SIGKILL kalau masih hidup setelah KILL_GRACE_MS. Aman dipanggil
 * berkali-kali dan buat child yang udah mati.
 */
function killChild(child) {
  if (!child || child.killed) return
  try {
    child.kill('SIGTERM')
  } catch {
    // proses mungkin udah mati
  }
  const t = setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL')
    } catch {
      // abaikan
    }
  }, KILL_GRACE_MS)
  // Jangan tahan event loop cuma buat timer kill.
  if (typeof t.unref === 'function') t.unref()
}

/**
 * Ambil teks yang enak dibaca dari satu event stream-json Claude Code.
 * Bentuk event beda-beda antar versi CLI, jadi kita coba beberapa jalur
 * umum dan fallback ke JSON mentah biar nggak ada info yang ilang.
 */
function extractText(evt) {
  if (evt == null) return ''

  // Event assistant/user: { message: { content: [{ type, text }] } }
  const content = evt.message?.content ?? evt.content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      } else if (block?.type === 'tool_use') {
        parts.push(`⚙︎ tool_use: ${block.name ?? '?'}`)
      } else if (block?.type === 'tool_result') {
        const t = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        parts.push(`↳ tool_result: ${t}`)
      }
    }
    if (parts.length) return parts.join('\n')
  }

  // Event result akhir: { type: "result", result: "<teks>" }
  if (typeof evt.result === 'string') return evt.result

  // Event system (init dsb) — kasih ringkasan singkat.
  if (evt.type === 'system') {
    return `system: ${evt.subtype ?? ''}`.trim()
  }

  // Fallback: JSON mentah biar nggak ada yang ketinggalan.
  return JSON.stringify(evt)
}

wss.on('connection', (socket) => {
  // Batas koneksi concurrent — tolak kalau udah penuh biar satu aktor nggak
  // bisa nyedot resource lewat banyak koneksi. (wss.clients udah termasuk
  // socket ini, jadi bandingin dengan > MAX_CLIENTS.)
  if (wss.clients.size > MAX_CLIENTS) {
    send(socket, {
      type: 'error',
      text: `Bridge penuh (maks ${MAX_CLIENTS} koneksi) — coba lagi nanti`,
    })
    socket.close()
    return
  }

  console.log(`[claude-bridge] client connected (${wss.clients.size} total)`)

  // Satu proses claude aktif per socket. Cegah run paralel dobel.
  let child = null
  // Timer timeout run yang lagi jalan (di-clear saat proses selesai).
  let runTimer = null

  /** Bersihin timer + referensi child. Dipanggil di semua jalur akhir run. */
  function clearRun() {
    if (runTimer) {
      clearTimeout(runTimer)
      runTimer = null
    }
    child = null
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      send(socket, { type: 'error', text: 'Pesan bukan JSON valid' })
      return
    }

    // Allowlist ketat: cuma type "run" + field prompt yang diproses.
    if (msg?.type !== 'run') {
      send(socket, { type: 'error', text: `Tipe pesan nggak didukung: ${msg?.type}` })
      return
    }

    const prompt = typeof msg.prompt === 'string' ? msg.prompt.trim() : ''
    if (!prompt) {
      send(socket, { type: 'error', text: 'Prompt kosong' })
      return
    }

    // Tolak prompt kegedean sebelum spawn — cegah abuse payload.
    if (prompt.length > MAX_PROMPT_LEN) {
      send(socket, {
        type: 'error',
        text: `Prompt kepanjangan (${prompt.length} char, maks ${MAX_PROMPT_LEN})`,
      })
      return
    }

    if (child) {
      send(socket, { type: 'error', text: 'Masih ada run yang jalan — tunggu selesai' })
      return
    }

    // Prompt dilewatin sebagai argumen array — TANPA shell — jadi aman
    // dari injection. Cuma binary "claude" yang dieksekusi.
    const args = ['-p', prompt, ...CLAUDE_ARGS]
    try {
      child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      clearRun()
      send(socket, { type: 'error', text: 'claude CLI tidak ditemukan' })
      return
    }

    // Arm timeout: proses yang lewat batas di-kill paksa + kabarin client.
    runTimer = setTimeout(() => {
      send(socket, {
        type: 'error',
        text: `Run timeout (${Math.round(RUN_TIMEOUT_MS / 1000)}s) — proses dihentikan`,
      })
      killChild(child)
      // 'close' bakal firing setelah kill dan ngirim { done }.
    }, RUN_TIMEOUT_MS)

    // Kalau binary nggak ada di PATH, error muncul async lewat 'error'.
    child.on('error', (err) => {
      const notFound = err && err.code === 'ENOENT'
      send(socket, {
        type: 'error',
        text: notFound ? 'claude CLI tidak ditemukan' : `Gagal spawn claude: ${err.message}`,
      })
      clearRun()
    })

    // stdout: baca baris per baris, parse tiap baris stream-json.
    let stdoutBuf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data) => {
      stdoutBuf += data
      let nl
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        emitLine(line)
      }
    })

    // stderr: kirim apa adanya sebagai chunk level error.
    let stderrBuf = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data) => {
      stderrBuf += data
      let nl
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl)
        stderrBuf = stderrBuf.slice(nl + 1)
        if (line.trim()) send(socket, { type: 'chunk', level: 'error', text: line })
      }
    })

    function emitLine(line) {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const evt = JSON.parse(trimmed)
        send(socket, { type: 'chunk', text: extractText(evt) })
      } catch {
        // Bukan JSON valid → kirim apa adanya.
        send(socket, { type: 'chunk', text: line })
      }
    }

    child.on('close', (code) => {
      // Flush sisa buffer yang belum ada newline-nya.
      if (stdoutBuf.trim()) emitLine(stdoutBuf)
      if (stderrBuf.trim()) send(socket, { type: 'chunk', level: 'error', text: stderrBuf })
      stdoutBuf = ''
      stderrBuf = ''
      send(socket, { type: 'done', code })
      clearRun()
    })
  })

  socket.on('close', () => {
    // Bunuh proses yang masih jalan kalau client putus (graceful → paksa).
    killChild(child)
    clearRun()
    console.log(`[claude-bridge] client disconnected (${wss.clients.size} left)`)
  })

  socket.on('error', () => {
    killChild(child)
    clearRun()
  })
})

console.log(`[claude-bridge] listening on ws://${HOST}:${PORT}`)
if (TOKEN_AUTOGEN) {
  // Token di-generate otomatis — print sekali biar client bisa dipakein.
  // Set CLAUDE_BRIDGE_TOKEN sendiri kalau mau token stabil antar restart.
  console.log(`[claude-bridge] token (auto): ${TOKEN}`)
  console.log(`[claude-bridge] connect: ws://${HOST}:${PORT}/?token=${TOKEN}`)
  console.log(
    '[claude-bridge] set VITE_CLAUDE_WS_TOKEN=<token> di .env biar UI kepakein',
  )
} else {
  console.log('[claude-bridge] token: dari env CLAUDE_BRIDGE_TOKEN')
}
console.log(`[claude-bridge] origin allowlist: ${[...ALLOWED_ORIGINS].join(', ')}`)
console.log(
  `[claude-bridge] limits: timeout=${RUN_TIMEOUT_MS}ms, maxClients=${MAX_CLIENTS}, ` +
    `maxPromptLen=${MAX_PROMPT_LEN}, killGrace=${KILL_GRACE_MS}ms`,
)
