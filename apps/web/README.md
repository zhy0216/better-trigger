# @better-trigger/web

The Better Trigger dashboard — a run-observability UI for background tasks.
Vite + React 19 + TypeScript + Tailwind 4.

## Scripts

```bash
bun run dev        # vite dev server (http://localhost:5173)
bun run build      # tsc --noEmit && vite build  → dist/
bun run preview    # serve the production build
bun run typecheck  # tsc --noEmit
bun run lint       # eslint (JavaScript/config files; TypeScript via tsc)
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
VITE_BT_API_KEY=local-dev-secret VITE_BT_API_URL=http://localhost:4848 bun run dev
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
├── vite-env.d.ts        # Vite/VITE_* typing
├── api/
│   ├── client.ts        # fetch wrapper (auth, error mapping)
│   ├── adapter.ts       # server JSON → types.ts shapes
│   ├── hooks.ts         # polling hooks + connection aggregation
│   └── mergeRuns.ts     # keyset page merge (PF3)
├── hooks/
│   └── useTweaks.ts     # tweak state (host-protocol persistence removed)
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
    └── index.css        # Tailwind 4 entrypoint
```

## Design system & Tailwind

Styling is driven by **CSS custom properties** (see `styles/tokens.css` and
`styles/theme.css`), switched by `data-theme` / `data-density` on `<html>` and
an `--accent` override set from `App.tsx`. Components mostly read those variables
directly via inline styles.

Tailwind 4 is wired through the `@tailwindcss/postcss` plugin and keeps the
legacy token map in `tailwind.config.ts` (loaded from `styles/index.css`), so
new UI can use `bg-surface`, `text-fg-muted`, `border-line`, `font-mono`,
`text-status-running`, etc. CSS load order in
`main.tsx` puts the tokens/theme **after** Tailwind's preflight so the design
system wins on shared element rules.

## The Tweaks panel

`TweaksPanel` is a floating control panel (theme / accent / density / trace
style) with a full set of form controls (`TweakSlider`, `TweakToggle`,
`TweakRadio`, `TweakSelect`, `TweakNumber`, `TweakColor`, `TweakButton`).

It was originally built for an external editing host and wired to a
postMessage protocol (`__activate_edit_mode` / `__deactivate_edit_mode` in,
`__edit_mode_available` / `__edit_mode_dismissed` / `__edit_mode_set_keys`
out). **That host protocol was removed** — it was documented as dead, and the
unorigin-checked `window` listener plus the `'*'` posts were a security hole.
No message listener or postMessage call remains.

The panel starts hidden and is toggled from the top bar's settings button
(p2-19): `App.tsx` holds the `open` boolean, `Shell`'s `IconButton` flips it,
and the panel receives `open` / `onOpenChange`.

```ts
// App.tsx — state lives here, Shell exposes the built-in toggle
const [tweaksOpen, setTweaksOpen] = React.useState(false);
<TweaksPanel open={tweaksOpen} onOpenChange={setTweaksOpen}>…</TweaksPanel>
```

## Notes from the conversion

This app was exported from a single Babel-in-browser HTML prototype. The main
mechanical changes:

- `window.*` globals → ES module `import` / `export`
- `window.BT_DATA` → the live API client (`src/api/client.ts`)
- added `types.ts` and prop interfaces throughout (strict TS)
- React/Babel CDN `<script>` tags → Vite bundling
