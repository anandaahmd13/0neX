# 0neX

**Personal AI Gateway + AI Agent Orchestration** untuk memakai banyak akun/provider AI lewat satu endpoint milik sendiri, memantau usage, dan menjalankan agent lokal.

Tampilan menggunakan gaya **neo-brutalist** dengan React, TypeScript, dan Tailwind CSS.

> Status: **v0.3** — OpenAI-compatible gateway, encrypted provider connections, usage telemetry, serta playground Claude dan Kiro CLI. Data workflow/agent utama masih dipersist di browser.

## Fitur

- **Personal AI Gateway** — endpoint `POST /v1/chat/completions` dan `GET /v1/models` yang kompatibel dengan SDK OpenAI.
- **Provider Connections** — kelola provider OpenAI-compatible dan Kiro CLI lokal; API key terenkripsi AES-256-GCM di server.
- **Usage Overview** — request, model, connection, status, latency, token usage, time series, dan request terbaru dari telemetry aktual.
- **CLI Playground** — percakapan multi-sesi lewat Claude Code atau Kiro CLI lokal dengan streaming, cancel, resume context, dan pencatatan otomatis ke Runs.
- **Dashboard** — ringkasan request, token, agent aktif, success rate, chart, dan run terbaru.
- **Agents** — profil agent dengan provider, model, system prompt, tool policy, tools, dan metrik.
- **Workflows** — canvas node-based untuk merangkai trigger, agent, tool, dan output.
- **Runs** — kirim task, pantau status, log, token usage, durasi, dan output.

## Stack

- [Vite](https://vite.dev) + React 19 + TypeScript
- [Tailwind CSS v4](https://tailwindcss.com)
- [React Router](https://reactrouter.com)
- [Recharts](https://recharts.org)
- Node.js HTTP + WebSocket (`ws`)
- Node.js built-in `node:test`

## Development

Butuh Node.js 22+ dan pnpm 11.

```powershell
pnpm install
Copy-Item .env.example .env
# Ganti seluruh token/key contoh di .env dengan nilai acak yang kuat.
pnpm gateway                 # terminal 1: HTTP + WS di 127.0.0.1:8788
pnpm dev                     # terminal 2: UI di localhost:5199
```

Buka halaman **AI Gateway → Connections**, pilih **OpenAI-compatible HTTP** atau **Kiro CLI Headless**, lalu jalankan **Test API key**. Connection Kiro meminta API key Kiro dan menyimpannya terenkripsi di host gateway.

Untuk Kiro, binary `kiro-cli` hanya perlu terpasang di mesin/server yang menjalankan gateway—bukan di setiap device yang memakai gateway. Host menjalankan `kiro-cli chat --no-interactive` dengan API key dalam `HOME` terisolasi. Device lain cukup memakai URL `/v1` dan `GATEWAY_API_KEY` milik gateway. Provider Kiro Playground memakai `KIRO_API_KEY` dari `.env`; Connection Kiro memakai key terenkripsi milik connection.

### Batas kompatibilitas Kiro Connection

Facade OpenAI untuk Kiro mendukung chat teks, satu choice, model `auto`, non-streaming, dan format SSE buffered. Kiro headless bersifat stateless: tidak ada resume session, pemilihan model arbitrary, atau token usage. Request tool calling, multimodal, audio, `response_format`, legacy completions, dan embeddings ditolak eksplisit. `stream: true` tetap menghasilkan SSE yang kompatibel, tetapi isi jawaban baru dikirim setelah proses headless selesai—bukan token streaming realtime.

## Memakai endpoint Gateway

Model gateway memakai format:

```text
<connection-id>/<upstream-model>
```

Slash setelah connection ID tetap menjadi bagian model upstream. Contoh OpenRouter:

```text
openrouter/anthropic/claude-sonnet-4
```

### OpenAI SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'https://ai.example.com/v1',
  apiKey: process.env.ONEX_GATEWAY_API_KEY,
})

const result = await client.chat.completions.create({
  model: 'openrouter/anthropic/claude-sonnet-4',
  messages: [{ role: 'user', content: 'Halo dari gateway pribadi.' }],
})

console.log(result.choices[0].message.content)
```

### curl

```bash
curl https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer $ONEX_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter/anthropic/claude-sonnet-4",
    "messages": [{"role": "user", "content": "Halo"}]
  }'
```

Gunakan `stream: true` seperti API OpenAI biasa untuk response SSE. Token hanya dicatat bila upstream mengirim field `usage`; Gateway tidak mengarang estimasi token.

## Arsitektur Gateway

```text
OpenAI SDK / app ── HTTPS ──> /v1/* ──> connection router ──> HTTP upstream
                                  │                  └──> Kiro CLI Headless
                                  └──> usage metadata JSONL

Private dashboard ───────────> /admin/* ──> encrypted connection store
CLI Playground ── WebSocket ─> provider registry ──> Claude Code / Kiro Headless
```

- [`server/gateway-server.mjs`](server/gateway-server.mjs) melayani HTTP dan WebSocket pada host/port yang sama, termasuk auth, CORS, body/output limits, timeout, dan routing.
- [`server/gateway/connection-store.mjs`](server/gateway/connection-store.mjs) menyimpan metadata connection secara atomik.
- [`server/gateway/secrets.mjs`](server/gateway/secrets.mjs) mengenkripsi provider API key dengan AES-256-GCM dan `GATEWAY_MASTER_KEY`.
- [`server/gateway/usage-store.mjs`](server/gateway/usage-store.mjs) menyimpan metadata request append-only. Prompt, completion, dan provider API key tidak disimpan.
- [`server/gateway/openai-compatible.mjs`](server/gateway/openai-compatible.mjs) menangani model routing, safe upstream errors, dan ekstraksi usage SSE.
- [`server/gateway/providers/claude-cli.mjs`](server/gateway/providers/claude-cli.mjs) menangani lifecycle Claude CLI lokal.
- [`server/gateway/kiro-runner.mjs`](server/gateway/kiro-runner.mjs) dan [`server/gateway/kiro-transport.mjs`](server/gateway/kiro-transport.mjs) menangani proses Kiro CLI, ACP JSON-RPC, auth isolation, streaming, dan cancellation.
- [`server/gateway/providers/kiro-cli.mjs`](server/gateway/providers/kiro-cli.mjs) menghubungkan shared Kiro runner ke Playground.

Data server default berada di `.data/gateway/` dan diabaikan Git. Jangan mengubah `GATEWAY_MASTER_KEY` setelah connection dibuat; key baru tidak bisa mendekripsi secret lama.

## Deployment dengan domain sendiri

Gateway default bind ke `127.0.0.1`. Pasang reverse proxy ber-TLS (Caddy, nginx, Cloudflare Tunnel, atau ekuivalen) di depan proses Node dan arahkan domain, misalnya `ai.example.com`, ke port Gateway.

Trust boundary yang disarankan:

- expose hanya `/v1/*` ke client publik dan lindungi dengan `GATEWAY_API_KEY`;
- batasi `/admin/*`, dashboard, dan WebSocket ke jaringan privat, VPN, atau access-control terpisah;
- jangan expose port Node langsung ke internet;
- gunakan HTTPS, rate limiting, request-size limit, dan log redaction di reverse proxy;
- backup `.data/gateway/` bersama `GATEWAY_MASTER_KEY` secara aman;
- set `ALLOWED_ORIGINS` hanya ke origin dashboard yang dipercaya.

`VITE_GATEWAY_ADMIN_TOKEN` dan token Vite lain tertanam di browser bundle. Itu aman hanya bila dashboard memang privat; token Vite bukan autentikasi multi-user. Untuk deployment publik, reverse proxy wajib menolak akses eksternal ke `/admin/*`.

## Validasi

```bash
pnpm test     # unit + integration test dengan fake OpenAI-compatible upstream
pnpm lint
pnpm build
```

Test integrasi mencakup encrypted connection storage, migrasi schema, auth/CORS, model discovery, OpenAI dan Kiro non-stream/SSE, ACP session/cancel, API-key isolation, broken-pipe handling, usage capture, serta larangan menyimpan prompt/secret pada telemetry.

## Struktur

```text
server/
├── gateway-server.mjs
└── gateway/
    ├── connection-store.mjs
    ├── openai-compatible.mjs
    ├── provider-registry.mjs
    ├── secrets.mjs
    ├── usage-store.mjs
    └── providers/
        └── claude-cli.mjs
src/
├── components/
├── pages/
│   ├── Gateway.tsx
│   └── Playground.tsx
├── lib/
│   ├── gatewayApi.ts
│   └── useGatewayStream.ts
├── data/mock.ts
└── types.ts
test/
├── gateway-server.test.mjs
└── gateway-storage.test.mjs
```
