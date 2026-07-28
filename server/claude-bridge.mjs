// 0neX — Claude Code bridge (WebSocket → headless `claude -p`).
//
// POC lokal: nyambungin UI ke Claude Code CLI dalam mode headless dan
// nge-stream output-nya real-time ke client. Client kirim
// { type: "run", prompt: "<teks>" }, bridge nyalain `claude -p` dan
// ngirim balik { type: "chunk" } per event, ditutup { type: "done" }.
//
// Keamanan: cuma binary "claude" yang dijalanin. Prompt dilewatin sebagai
// argumen array (bukan shell string) biar aman dari injection. Nggak ada
// command arbitrer dari client — cuma field `prompt` yang dipakai.
//
// Jalankan: pnpm claude-bridge   (atau: node server/claude-bridge.mjs)

import { WebSocketServer } from 'ws'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.WS_PORT ?? 8788)

// Argumen tetap buat mode headless + streaming JSON.
const CLAUDE_ARGS = ['--output-format', 'stream-json', '--verbose']

const wss = new WebSocketServer({ port: PORT })

/** Kirim objek JSON ke socket kalau masih kebuka. */
function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
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
  console.log(`[claude-bridge] client connected (${wss.clients.size} total)`)

  // Satu proses claude aktif per socket. Cegah run paralel dobel.
  let child = null

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
      child = null
      send(socket, { type: 'error', text: 'claude CLI tidak ditemukan' })
      return
    }

    // Kalau binary nggak ada di PATH, error muncul async lewat 'error'.
    child.on('error', (err) => {
      const notFound = err && err.code === 'ENOENT'
      send(socket, {
        type: 'error',
        text: notFound ? 'claude CLI tidak ditemukan' : `Gagal spawn claude: ${err.message}`,
      })
      child = null
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
      child = null
    })
  })

  socket.on('close', () => {
    // Bunuh proses yang masih jalan kalau client putus.
    if (child) {
      child.kill()
      child = null
    }
    console.log(`[claude-bridge] client disconnected (${wss.clients.size} left)`)
  })

  socket.on('error', () => {
    if (child) {
      child.kill()
      child = null
    }
  })
})

console.log(`[claude-bridge] listening on ws://localhost:${PORT}`)
