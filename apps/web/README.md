# @better-trigger/web

The Better Trigger dashboard — a run-observability UI for background tasks.
Vite + React 18 + TypeScript + Tailwind.

## Scripts

```bash
pnpm dev         # vite dev server (http://localhost:5173)
pnpm build       # tsc --noEmit && vite build  → dist/
pnpm preview     # serve the production build
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
```

## API key mode

When the daemon has `BETTER_TRIGGER_API_KEY` set, the dashboard asks for the
matching token after the first `401` response and sends it as a Bearer token on
subsequent requests. A manually entered key is memory-only: it is not written
to `localStorage`, `sessionStorage`, cookies, or any other persistent store,
and a page refresh clears it.

The daemon serves the production build itself (`apps/worker` embeds `dist/`),
so that build defaults to **same-origin** API access: without
`VITE_BT_API_URL` it talks to the origin it was loaded from, works from any
host:port the daemon is reached at, and needs no CORS. Only the Vite dev
server falls back to `http://localhost:4848` when `VITE_BT_API_URL` is unset.

For local development only, `VITE_BT_API_KEY` can provide the initial key:

```bash
VITE_BT_API_KEY=local-dev-secret VITE_BT_API_URL=http://localhost:4848 pnpm dev
```

Vite embeds `VITE_*` values in the browser bundle. Therefore
`VITE_BT_API_KEY` is **not safe for public deployments** and must never contain
a long-lived production bearer secret. Use an authenticated same-origin
deployment/session instead.

## Source map

```
src/
├── main.tsx              # React entry; imports the three CSS layers
├── App.tsx              # routing, theme/density/accent, Tweaks wiring
├── types.ts            # shared domain types (Run, Span, Trace, …)
├── data/
│   └── mock.ts          # typed mock data (was window.BT_DATA)
├── hooks/
│   └── useTweaks.ts     # tweak state + host-protocol persistence
├── components/
│   ├── primitives.tsx   # Icon, Button, Badge, StatusBadge, Input, Sparkline…
│   ├── Layout.tsx       # Page, Card, Metric, SectionHead
│   ├── Shell.tsx        # Logo, Sidebar, TopBar, EnvSwitcher
│   └── TweaksPanel.tsx  # floating tweak panel + form controls
├── features/
│   └── run/RunView.tsx  # the hero: live waterfall trace + logs + inspector
├── screens/
│   ├── RunsList.tsx
│   ├── TasksDashboard.tsx
│   ├── Schedules.tsx
│   ├── Alerts.tsx
│   ├── Deployments.tsx
│   └── Onboarding.tsx
└── styles/
    ├── tokens.css       # Runner AI color/type/space tokens
    ├── theme.css        # light/dark surfaces, density, keyframes
    └── index.css        # @tailwind base/components/utilities
```

## Design system & Tailwind

Styling is driven by **CSS custom properties** (see `styles/tokens.css` and
`styles/theme.css`), switched by `data-theme` / `data-density` on `<html>` and
an `--accent` override set from `App.tsx`. Components mostly read those variables
directly via inline styles.

Tailwind is wired up and maps the most-used tokens to utilities
(`tailwind.config.ts`), so new UI can use `bg-surface`, `text-fg-muted`,
`border-line`, `font-mono`, `text-status-running`, etc. CSS load order in
`main.tsx` puts the tokens/theme **after** Tailwind's preflight so the design
system wins on shared element rules.

## The Tweaks panel

`TweaksPanel` is a floating control panel (theme / accent / density / trace
style). It was built for an external editing host: it opens when it receives an
`__activate_edit_mode` postMessage. **Standalone, it stays hidden by default.**
To make it user-toggleable, hold an `open` boolean in `App.tsx` and either pass
it into the panel or dispatch the activate/deactivate messages to `window`:

```ts
// open the panel
window.postMessage({ type: '__activate_edit_mode' }, '*');
// close it
window.postMessage({ type: '__deactivate_edit_mode' }, '*');
```

## Notes from the conversion

This app was exported from a single Babel-in-browser HTML prototype. The main
mechanical changes:

- `window.*` globals → ES module `import` / `export`
- `window.BT_DATA` → typed exports in `data/mock.ts`
- added `types.ts` and prop interfaces throughout (strict TS)
- React/Babel CDN `<script>` tags → Vite bundling
- playback position still persists to `localStorage` (`bt_playback`)
