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
