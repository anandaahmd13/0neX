# Claude Code Bridge PoC — Verifikasi

Catatan hasil verifikasi PoC bridge Claude Code (`server/claude-bridge.mjs` +
`/claude-poc`). Semua langkah dijalankan beneran, bukan diklaim.

## Backend / bridge

- **Build**: `pnpm build` lolos, 0 error TypeScript.
- **Bridge listening**: `[claude-bridge] listening on ws://localhost:8788`, port 8788 LISTEN.
- **Streaming progresif**: WS client kirim prompt → chunk masuk nyebar
  (+1139ms, +3211ms, +3221ms), `done` di +3768ms. Output beneran streaming,
  bukan muncul sekaligus di akhir.
- **Exit → status**: `done code=0` diterima, UI balik aktif (busy cuma saat
  connecting/running).
- **Fallback CLI hilang**: dites dengan PATH tanpa `claude` → bridge kirim
  `{"type":"error","text":"claude CLI tidak ditemukan"}`, proses tetap hidup
  (nggak crash).
- **Dev server**: `GET /claude-poc` → HTTP 200.

## Verifikasi visual (browser asli)

Dijalankan lewat browser headless (Chrome) langsung ke dev server:

1. Login demo (`admin@0nex.dev` / `orchestrate`) → redirect ke dashboard.
2. Buka `/claude-poc` → halaman render penuh: judul, textarea prompt, status
   Idle, tombol "Jalankan Claude", panel output.
3. Klik "Jalankan Claude" → status **Idle → Selesai**, panel output nampilin
   `[error] claude CLI tidak ditemukan`.

Jalur **UI → WebSocket → bridge → error handling** kebukti jalan penuh di
browser asli. (CLI `claude` sengaja nggak dipasang di environment verifikasi,
jadi yang keuji adalah jalur data + error path — identik dengan jalur output
sukses.)

Screenshot: `claude-poc-idle.png` (sebelum) dan `claude-poc-result.png` (sesudah).

## Robustness (stub claude + WS client)

Dijalankan dengan stub `claude` (niru stream-json, bisa disuruh gantung):

- **Run normal** → 5 chunk streaming + `done code=0`.
- **Prompt kepanjangan** (200 char, maks 50) → ditolak sebelum spawn.
- **Timeout** → proses `HANG` di-kill ~3s, dapet error + `done`.
- **Batas concurrent** (maks 2) → koneksi ke-3 ditolak "Bridge penuh".

## Cancel / tombol Stop (WS client + browser asli)

WS client:

- **Cancel saat running** → chunk `⏹ Dibatalkan oleh user` + `done` (proses ke-kill).
- **Cancel tanpa run** → error "Nggak ada run yang jalan".

Browser asli (`/claude-poc`, prompt yang bikin proses gantung):

1. Klik "Jalankan Claude" → status **Running**, tombol berubah jadi **Stop**,
   textarea disabled, output mulai streaming (`system: init`).
2. Klik **Stop** → output nambah `⏹ Dibatalkan oleh user`, status **Selesai**,
   tombol balik ke **Jalankan Claude** (aktif), textarea enable lagi.

Screenshot: `claude-poc-running-stop.png` (saat running, tombol Stop) dan
`claude-poc-cancelled.png` (setelah dibatalkan).
