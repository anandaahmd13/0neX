# 0neX

**AI Agent Orchestration platform** untuk mengatur, merangkai, dan menjalankan agent AI dalam satu tempat.

Tampilan menggunakan gaya **neo-brutalist** dengan React, TypeScript, dan Tailwind CSS.

> Status: **v0.2** - frontend orchestration + Personal AI Gateway lokal. Data aplikasi utama masih dipersist di browser.

## Fitur

- **Dashboard** - ringkasan request, token, agent aktif, success rate, chart, dan run terbaru.
- **Agents** - profil agent dengan provider, model, system prompt, tool policy, tools, dan metrik.
- **Workflows** - canvas node-based untuk merangkai trigger, agent, tool, dan output.
- **Runs** - kirim task, pantau status, log, token usage, durasi, dan output.
- **Personal AI Gateway** - percakapan multi-sesi melalui kontrak provider-neutral, streaming, cancel, resume context, dan pencatatan otomatis ke Runs. Provider paket A adalah Claude Code CLI lokal.

## Stack

- [Vite](https://vite.dev) + React 19 + TypeScript
- [Tailwind CSS v4](https://tailwindcss.com)
- [React Router](https://reactrouter.com)
- [Recharts](https://recharts.org)
- Node.js + WebSocket (`ws`) untuk Personal AI Gateway

## Development

Butuh Node.js 22+ dan pnpm 11.

```bash
pnpm install
Copy-Item .env.example .env  # PowerShell, lalu samakan token Gateway
pnpm gateway                 # terminal 1: gateway lokal di 127.0.0.1:8788
pnpm dev                     # terminal 2: UI di localhost:5199
pnpm lint
pnpm build
```

Claude Code CLI harus tersedia sebagai perintah `claude` dan sudah terautentikasi. Script lama `pnpm claude-bridge` tetap berfungsi sebagai alias kompatibilitas.

## Arsitektur Gateway

```text
Gateway UI -> WebSocket protocol -> provider registry -> Claude CLI adapter
     |                                      |
     +-------------- Runs store <-----------+
```

- `server/gateway-server.mjs` menangani autentikasi token, origin allowlist, validasi payload, concurrency, dan batas output.
- `server/gateway/provider-registry.mjs` memisahkan protokol dari implementasi provider untuk persiapan paket B/C.
- `server/gateway/providers/claude-cli.mjs` menangani lifecycle Claude CLI, session resume, streaming, timeout, cancel, dan usage.
- `src/lib/useGatewayStream.ts` adalah transport client provider-neutral.

Gateway paket A ditujukan untuk pemakaian personal di loopback. Token Vite terlihat oleh browser dan bukan pengganti autentikasi server multi-user. Jangan bind ke jaringan publik sebelum paket security untuk deployment remote tersedia.

## Struktur

```text
server/
├── gateway-server.mjs
└── gateway/
    ├── provider-registry.mjs
    └── providers/claude-cli.mjs
src/
├── components/
├── pages/
├── data/mock.ts
├── lib/
├── types.ts
└── index.css
```
