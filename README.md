# Better Trigger — Turborepo

A background-job observability dashboard (Trigger.dev-style), built as a
**Turborepo** monorepo. The dashboard app lives in [`apps/web`](./apps/web).

## Stack

- **Turborepo** — task orchestration & caching
- **pnpm** workspaces
- **Vite 5** + **React 18** + **TypeScript 5** (strict)
- **Tailwind CSS 3** layered over a CSS-variable design system

## Layout

```
.
├── apps/
│   └── web/                 # the dashboard (Vite + React + TS + Tailwind)
├── packages/                # (empty) place shared packages here, e.g. @better-trigger/ui
├── package.json             # workspace root + turbo scripts
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.json            # shared compiler base, extended by each app
```

## Getting started

```bash
pnpm install        # install all workspaces
pnpm dev            # turbo run dev  → starts apps/web on http://localhost:5173
pnpm build          # turbo run build (tsc --noEmit + vite build)
pnpm typecheck      # turbo run typecheck
pnpm lint           # turbo run lint
```

> Uses pnpm by default. To use npm/yarn instead, delete `pnpm-workspace.yaml`
> and `pnpm-lock.yaml`; the `workspaces` field in the root `package.json` keeps
> npm/yarn working.

## Adding shared packages

Drop a package under `packages/` (e.g. `packages/ui`), give it a name like
`@better-trigger/ui`, and import it from `apps/web` — Turborepo + the workspace
globs (`apps/*`, `packages/*`) wire it up automatically. Good first extraction
candidates from `apps/web/src`: `components/primitives.tsx`, the design tokens
in `styles/`, and the `TweaksPanel`.

See [`apps/web/README.md`](./apps/web/README.md) for app-specific notes.
