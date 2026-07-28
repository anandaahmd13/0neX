# 0neX

**AI Agent Orchestration platform** — dashboard buat ngatur, ngerangkai, dan ngejalanin agent-agent AI lo dalam satu tempat.

Tampilan pakai gaya **neo-brutalist** (cream, border hitam tebal, hard shadow, font monospace) — terinspirasi dari desain [tukeria.com](https://tukeria.com).

> Status: **v0.1** — frontend + mock data. Backend (API + DB) nyusul.

## Fitur

- **Dashboard** — ringkasan real-time: total request, token terpakai, agent aktif, success rate, chart request, leaderboard agent, run terbaru.
- **Agents** — daftar agent dengan status (aktif/idle/paused/error), model, tools, dan metrik (token, request, success rate, latency). Bisa difilter per status.
- **Workflows** — canvas node-based buat ngerangkai agent jadi alur kerja (trigger → agent → tool → output) dengan edge & panah.
- **Runs** — kirim task ke orchestrator, pilih workflow, pantau daftar run + log terminal real-time dan output-nya.

## Stack

- [Vite](https://vite.dev) + React 19 + TypeScript
- [Tailwind CSS v4](https://tailwindcss.com)
- [React Router](https://reactrouter.com) — routing
- [Recharts](https://recharts.org) — chart

## Development

```bash
pnpm install     # butuh Node 22+ / pnpm 11
pnpm dev         # dev server
pnpm build       # production build
pnpm preview     # preview build hasil
```

## Struktur

```
src/
├── components/       # UI primitives (Button, Card, Badge, StatCard), Sidebar, Layout, icons
├── pages/            # Dashboard, Agents, Workflows, Runs
├── data/mock.ts      # mock data layer (agents, workflows, runs, stats)
├── lib/              # helper (cn, format)
├── types.ts          # domain types
└── index.css         # design tokens + neo-brutalist utilities
```

## Design tokens

| Token        | Value       | Fungsi              |
| ------------ | ----------- | ------------------- |
| `cream`      | `#FAFAF5`   | background          |
| `ink`        | `#1A1A1A`   | teks & border       |
| `mustard`    | `#FAAE2A`   | aksen primary       |
| `sky`        | `#8BD3DD`   | aksen secondary     |
| shadow-hard  | `4px 4px 0` | hard shadow (no blur) |

Font: **IBM Plex Mono** (body) + **Comfortaa** (brand).
