# ADR-001 — Arsitektur Claude Code Bridge

**Status:** Accepted (PoC)
**Tanggal:** 2026-07-28
**Konteks repo:** `onex-scaffold` — frontend flat (`src/`) + sidecar WS di `server/`.

## Konteks

Bridge Claude Code (`server/claude-bridge.mjs`) nyambungin UI ke Claude Code
CLI headless lewat WebSocket. Pertanyaannya: bridge ini mau ditaruh di mana
secara arsitektur?

Fakta repo saat ini:

- **Bukan monorepo.** Nggak ada `apps/web` / `apps/api`. Frontend ada di
  `src/` (Vite + React), tanpa backend HTTP app sama sekali.
- **Sudah ada pola sidecar WS.** `server/` udah punya dua server WS berdiri
  sendiri: `log-stream.mjs` (port 8787) dan `claude-bridge.mjs` (port 8788).
  Keduanya proses Node terpisah, dijalankan via script pnpm (`ws`,
  `claude-bridge`), dan frontend konek lewat env `VITE_*`.

## Opsi yang dipertimbangkan

### A. Tetap sidecar WS terpisah (dipilih)

Bridge jalan sebagai proses Node sendiri, sejajar `log-stream.mjs`.

- (+) Konsisten dengan pola yang **sudah ada** di repo — nggak ngenalin
  paradigma baru.
- (+) Isolasi: crash/hang di bridge (yang nge-spawn subprocess) nggak
  ngejatuhin server lain.
- (+) Surface keamanan kecil & fokus: satu file, allowlist ketat, gampang
  di-audit.
- (+) Bisa di-deploy/di-matiin independen (fitur eksperimental).
- (−) Satu proses lagi buat dikelola (mulai/stop/monitor).
- (−) Config port/token tersebar di beberapa tempat (dimitigasi `.env`).

### B. Gabung ke satu backend HTTP+WS

Bikin `apps/api` (mis. Fastify) dan pasang bridge sebagai route WS di situ.

- (+) Satu proses backend, satu tempat auth/config.
- (−) Backend HTTP **belum ada** — harus bikin dari nol cuma buat ini.
- (−) Nyampur eksekusi subprocess (berisiko) dengan server utama →
  blast radius lebih gede kalau bermasalah.
- (−) Menyimpang dari pola sidecar yang udah dipakai `log-stream.mjs`.

### C. Serverless / job runner eksternal

Antri prompt ke worker/queue terpisah.

- (−) Over-engineering buat PoC lokal. Tunda sampai ada kebutuhan
  multi-user / skala nyata.

## Keputusan

**Ambil Opsi A** — tetap sidecar WS terpisah. Alasan utama: sesuai konvensi
repo yang sudah ada (`log-stream.mjs`), isolasi risiko subprocess, dan surface
audit yang kecil. Bikin backend HTTP baru (Opsi B) belum sepadan untuk PoC.

## Konsekuensi

- Config bridge lewat env (`.env`, lihat `.env.example`): `WS_HOST`,
  `WS_PORT`, `CLAUDE_BRIDGE_TOKEN`, `ALLOWED_ORIGINS`, dan batas robustness.
- Frontend konek lewat `VITE_CLAUDE_WS_URL` + `VITE_CLAUDE_WS_TOKEN`.
- Operasional: bridge dijalankan `pnpm claude-bridge` (dev) berdampingan
  dengan `pnpm dev` dan `pnpm ws`.

## Kapan ditinjau ulang

Pindah ke Opsi B kalau salah satu terjadi:

1. Butuh **multi-user** dengan sesi/otorisasi per-user (bukan token tunggal).
2. Butuh **persistensi** riwayat run di backend.
3. Muncul backend HTTP (`apps/api`) untuk kebutuhan lain — saat itu konsolidasi
   jadi masuk akal.
