# 0neX — Design System (Neon Edition)

The 0neX UI is **neo-brutalist bones re-skinned in neon**: hard 2px borders,
offset drop-shadows, and a chunky press interaction — but lit with an electric
neon palette and a soft glow halo. Dark mode is the star of the show (void-black
canvas, luminous cyan/magenta), while light mode is a "daylight neon" variant.

Everything themes from **one file**: `src/index.css`. Components never hardcode
colors — they use semantic Tailwind utilities (`bg-cream`, `text-ink`,
`bg-mustard`, `shadow-hard`, …) that resolve to CSS custom properties. Change a
token, re-skin the whole app.

---

## Color tokens

All colors are CSS custom properties declared in `@theme` (light) and overridden
under `html.dark` (dark). The utility name on the left is what you write in JSX;
the role on the right is what it *means* — the utility names are historical
(carried over from the previous theme), so read them by role, not by literal name.

| Utility            | Role                | Light (`@theme`) | Dark (`html.dark`) |
| ------------------ | ------------------- | ---------------- | ------------------ |
| `bg-cream`         | App base / canvas   | `#f4f3ff`        | `#08070f`          |
| `bg-paper`         | Raised surface      | `#ffffff`        | `#12111f`          |
| `text-ink`         | Foreground + borders| `#14121f`        | `#e8f6ff`          |
| `bg-mustard`       | **PRIMARY** — cyan  | `#00c2d1`        | `#22f0ff`          |
| `*-mustard-dark`   | Primary pressed     | `#009fac`        | `#12c6d6`          |
| `bg-sky`           | **SECONDARY** — magenta | `#c026d3`    | `#ff3df2`          |
| `bg-sky-soft`      | Secondary tint      | `#f5d0fe`        | `#2a0f33`          |
| `text-ok`          | Success             | `#10d979`        | `#39ff14`          |
| `text-warn`        | Warning             | `#f5c211`        | `#ffe23d`          |
| `text-danger`      | Error / destructive | `#ff2e63`        | `#ff2e63`          |
| `text-idle`        | Muted / disabled    | `#9a97b8`        | `#56536e`          |

> **Naming note:** `mustard` = primary neon **cyan**, `sky` = secondary neon
> **magenta**. The old tukeria names stayed to avoid touching every component.
> If you rename them, do a project-wide swap and update this table.

### Neon halo

`--neon-halo` drives every glow (shadows, `.neon-text`, `.neon-glow`):

- Light: `rgba(0, 194, 209, 0.35)` — subtle cyan bloom
- Dark: `rgba(34, 240, 255, 0.55)` — bright electric bloom

---

## Shadows & glow

Neo-brutalist offset shadow **fused with a neon halo**. Three sizes, all token-driven:

| Utility          | Light (offset + halo)                                  | Dark (neon edge + halo)                                       |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| `shadow-hard-sm` | `2px 2px 0 ink, 0 0 8px -4px halo`                     | `2px 2px 0 cyan(.85), 0 0 12px -2px halo`                     |
| `shadow-hard`    | `4px 4px 0 ink, 0 0 14px -4px halo`                    | `3px 3px 0 cyan(.9), 0 0 20px -2px halo`                      |
| `shadow-hard-lg` | `6px 6px 0 ink, 0 0 22px -4px halo`                    | `5px 5px 0 cyan(.95), 0 0 32px -2px halo`                     |

On **dark**, the offset "ink" becomes a neon-cyan edge so cards look lit from
within. On **light**, the offset stays inky with a faint cyan bloom.

Extra glow helpers (in `@layer utilities`):

- `.neon-text` — cyan/magenta text-shadow for brand marks & hero headings.
- `.neon-glow` — standalone glow ring for focus / active emphasis.

---

## Interaction — the "press"

`.press` gives every card/button a tactile arcade feel:

- **hover** → lifts `translate(-1px, -1px)`, shadow grows to `shadow-hard-lg`
  (glow intensifies).
- **active** → sinks `translate(4px, 4px)`, shadow removed (button "presses in").

Pair `.press` with `.shadow-hard` on any bordered surface.

---

## Typography

- `--font-mono` → **IBM Plex Mono** — default body font (technical, terminal vibe).
- `--font-brand` → **Comfortaa** — brand mark / display headings, via `.font-brand`.

Both loaded in `index.html` from Google Fonts. Base size `16px`, antialiased.

---

## Surfaces & patterns

- **Card** (`components/ui/Card.tsx`): `rounded-xl border-2 border-ink bg-paper shadow-hard`.
  Add `hover` prop → `.press` + pointer cursor.
- **Button** (`components/ui/Button.tsx`): `rounded-lg border-2 border-ink`,
  variants map to tokens:
  - `primary` → `bg-mustard` (neon cyan)
  - `secondary` → `bg-sky` (neon magenta)
  - `ghost` → `bg-paper`
  - `danger` → `bg-danger`
  - disabled → `opacity-50 grayscale`, no press/shadow.
- **`.bg-grid`**: faint synthwave grid (24px). Grid line is magenta on light,
  cyan on dark (`--grid-line`).
- **Terminal** (`.term*`): fixed neon-on-black console, **theme-independent** —
  stays dark in both modes so logs never invert. Accents: `.term-accent` cyan,
  `.term-ok` green, `.term-warn` yellow, `.term-error` pink.
- **Scrollbar**: neon-cyan thumb (`bg-mustard`) on a canvas-colored track.

---

## Theming mechanism

`ThemeProvider` (`src/lib/theme.tsx`) toggles `html.dark`, persists the choice to
`localStorage['0nex.theme']`, and defaults to the OS `prefers-color-scheme`.
Because every utility resolves to a token and the dark tokens live under
`html.dark`, toggling the class re-skins the entire app with a 0.2s
background/color transition — no per-component dark: variants needed.

---

## Adding or changing colors

1. Edit the token value in **both** `@theme` (light) and `html.dark` (dark) in
   `src/index.css`. Keep contrast readable on each canvas.
2. Never hardcode a hex in a component — introduce a semantic token instead.
3. If you touch the halo or shadow recipe, keep the offset + `0 0 …px halo`
   two-layer structure so the neon glow stays consistent.
4. Re-run `pnpm build` to confirm Tailwind picks up the tokens.
