# 0neX

**Personal AI Gateway + AI Agent Orchestration** untuk memakai banyak akun/provider AI lewat satu endpoint milik sendiri, memantau usage, dan menjalankan agent lokal.

Tampilan menggunakan gaya **neo-brutalist** dengan React, TypeScript, dan Tailwind CSS.

> Status: **v0.3** — OpenAI-compatible gateway, encrypted provider connections, usage telemetry, serta Playground Claude CLI dan Kiro HTTPS. Data workflow/agent utama masih dipersist di browser.

## Fitur

- **Personal AI Gateway** — endpoint `POST /v1/chat/completions` dan `GET /v1/models` yang kompatibel dengan SDK OpenAI.
- **Provider Connections** — kelola provider OpenAI-compatible dan Kiro HTTPS; API key terenkripsi AES-256-GCM di server.
- **Gateway API Keys** — terbitkan key `onex_sk_…` per client lewat dashboard, dengan scope, expiry, rate limit, rotate/revoke, dan atribusi usage per key. Server hanya menyimpan hash-nya.
- **Usage Overview** — request, model, connection, status, latency, token usage, time series, dan request terbaru dari telemetry aktual.
- **AI Playground** — percakapan multi-sesi lewat Claude Code CLI atau Kiro HTTPS dengan streaming, cancel, dan pencatatan otomatis ke Runs.
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

Buka halaman **AI Gateway → Connections**, pilih **OpenAI-compatible HTTP** atau **Kiro HTTPS**, lalu jalankan **Test API key**. Connection Kiro memvalidasi API key ke CodeWhisperer lewat HTTPS dan menyimpannya terenkripsi di host gateway.

Kiro tidak membutuhkan binary atau environment key global. Inference melakukan HTTPS langsung ke `runtime.<region>.kiro.dev/generateAssistantResponse` dengan region, profile ARN, dan credential milik connection yang dipilih. Di **AI Playground**, pilih connection Kiro tersimpan; browser hanya mengirim ID connection dan tidak pernah menerima API key.

### Batas kompatibilitas Kiro Connection

Facade OpenAI untuk Kiro mendukung chat teks, satu choice, model `auto`, respons non-stream, dan SSE streaming realtime dari AWS EventStream. Kiro tetap stateless: tidak ada resume session atau pemilihan model arbitrary. Request tool calling, multimodal, audio, `response_format`, legacy completions, dan embeddings ditolak eksplisit. Token usage dicatat bila runtime mengirim event metrics.

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

## Dua jenis API key

Jangan tertukar: **Kiro API key** adalah credential provider (disimpan terenkripsi di connection store), sedangkan **Gateway API key** adalah key yang dipakai OpenCode/client lain untuk memanggil domain gateway.

| | Kiro API key | Gateway API key |
| --- | --- | --- |
| Dipakai oleh | gateway → runtime Kiro | OpenCode/SDK → `/v1/*` milik lo |
| Dibuat di | Gateway → Connections | Gateway → API Keys |
| Disimpan sebagai | ciphertext AES-256-GCM (bisa didekripsi untuk inference) | HMAC-SHA256 keyed hash (tidak bisa dibalik) |

### Gateway → API Keys

Alur dashboard:

1. Buka **Gateway → API Keys**, klik **Create API Key**.
2. Isi nama (misalnya `OpenCode Laptop`), pilih scope `models:read` dan/atau `chat:write`, opsional set expiration date dan rate limit (burst + refill/detik).
3. Gateway menerbitkan key `onex_sk_…`. **Plaintext hanya ditampilkan sekali** — server cuma menyimpan hash-nya. Kalau hilang, rotate.
4. Key bisa di-**rotate** (secret baru, secret lama langsung mati), di-**disable**, di-**revoke** (record tetap ada sebagai jejak audit), atau dihapus permanen.
5. Overview menampilkan kartu **API key pemakai**, jadi terlihat key/client mana yang memakai token: telemetry mencatat `keyId` per request.

Konfigurasi OpenCode:

```json
{
  "baseURL": "https://ai.example.com/v1",
  "apiKey": "onex_sk_...",
  "model": "kiro-main/auto"
}
```

Request-nya memakai `Authorization: Bearer onex_sk_...`.

Endpoint admin di belakang layar (butuh sesi dashboard atau `GATEWAY_ADMIN_TOKEN`, dan Origin yang di-allowlist):

```text
GET    /admin/api-keys
POST   /admin/api-keys
PATCH  /admin/api-keys/:id
POST   /admin/api-keys/:id/rotate
DELETE /admin/api-keys/:id            # hapus record
DELETE /admin/api-keys/:id?mode=revoke # matikan, record disimpan
```

Scope diberlakukan di `/v1`: `models:read` untuk `GET /v1/models`, `chat:write` untuk `/v1/chat/completions`, `/v1/completions`, dan `/v1/embeddings`. Key yang revoked/disabled/expired ditolak 401 dengan kode `api_key_revoked`, `api_key_disabled`, atau `api_key_expired`; scope kurang ditolak 403 `insufficient_scope`.

`GATEWAY_API_KEY` di `.env` tetap berlaku sebagai **bootstrap/emergency key** dengan scope penuh (telemetry-nya tercatat sebagai `Bootstrap (GATEWAY_API_KEY)`). Untuk pemakaian sehari-hari, pakai key yang dibuat lewat dashboard supaya bisa dicabut per client tanpa mengganggu yang lain. Bikin nilai acak untuk bootstrap key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Arsitektur Gateway

```text
OpenAI SDK / app ── HTTPS ──> /v1/* ──> connection router ──> HTTP upstream
                                  │                  └──> Kiro HTTPS runtime
                                  └──> usage metadata JSONL

Private dashboard ───────────> /admin/* ──> encrypted connection store
AI Playground ──── WebSocket ─> provider registry ──> Claude CLI / Kiro HTTPS
```

- [`server/gateway-server.mjs`](server/gateway-server.mjs) melayani HTTP dan WebSocket pada host/port yang sama, termasuk auth, CORS, body/output limits, timeout, dan routing.
- [`server/gateway/connection-store.mjs`](server/gateway/connection-store.mjs) menyimpan metadata connection secara atomik.
- [`server/gateway/secrets.mjs`](server/gateway/secrets.mjs) mengenkripsi provider API key dengan AES-256-GCM dan `GATEWAY_MASTER_KEY`.
- [`server/gateway/api-key-store.mjs`](server/gateway/api-key-store.mjs) menyimpan API key gateway sebagai HMAC-SHA256 keyed hash (kunci = `GATEWAY_MASTER_KEY`), plus scope, expiry, rate limit, dan counter pemakaian. Plaintext key tidak pernah ditulis ke disk.
- [`server/gateway/usage-store.mjs`](server/gateway/usage-store.mjs) menyimpan metadata request append-only, termasuk `keyId` pemanggil untuk atribusi per API key. Prompt, completion, dan provider API key tidak disimpan.
- [`server/gateway/openai-compatible.mjs`](server/gateway/openai-compatible.mjs) menangani model routing, safe upstream errors, dan ekstraksi usage SSE.
- [`server/gateway/providers/claude-cli.mjs`](server/gateway/providers/claude-cli.mjs) menangani lifecycle Claude CLI lokal.
- [`server/gateway/kiro-http.mjs`](server/gateway/kiro-http.mjs) membangun request `GenerateAssistantResponse`, memanggil runtime regional, dan mem-parse AWS EventStream secara incremental.
- [`server/gateway/providers/kiro-cli.mjs`](server/gateway/providers/kiro-cli.mjs) mempertahankan provider ID lama demi kompatibilitas, tetapi menjalankan Kiro HTTPS memakai connection terenkripsi yang dipilih di Playground.

Data server default berada di `.data/gateway/` dan diabaikan Git. Jangan mengubah `GATEWAY_MASTER_KEY` setelah connection dibuat; key baru tidak bisa mendekripsi secret lama.

## Deployment dengan domain sendiri

Gateway default bind ke `127.0.0.1`. Pasang reverse proxy ber-TLS (Caddy, nginx, Cloudflare Tunnel, atau ekuivalen) di depan proses Node dan arahkan domain, misalnya `ai.example.com`, ke port Gateway.

Trust boundary yang disarankan:

- expose hanya `/v1/*` ke client publik dan lindungi dengan API key gateway (satu key per client dari **Gateway → API Keys**; `GATEWAY_API_KEY` disimpan sebagai bootstrap/emergency saja);
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
    ├── api-key-store.mjs
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
├── gateway-api-key-routes.test.mjs
├── gateway-api-keys.test.mjs
├── gateway-server.test.mjs
└── gateway-storage.test.mjs
```
