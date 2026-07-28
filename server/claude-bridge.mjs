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

// Backward-compatible entry point. Personal AI Gateway sekarang menjadi server
// provider-neutral; Claude Code CLI diregistrasikan sebagai provider pertama.
import './gateway-server.mjs'
