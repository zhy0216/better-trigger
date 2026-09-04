# Agent Instructions

## Bun is the package manager and runtime

Use Bun exclusively for this repository. The project declares Bun `1.4.0` in
`package.json`; use that version (or a compatible newer Bun release) for local
work.

- Install dependencies with `bun install`.
- Run package scripts with `bun run <script>` (for example,
  `bun run build`, `bun run test`, and `bun run lint`).
- Execute project TypeScript or JavaScript files with `bun <file>`.
- Run package binaries with `bunx --bun <command>`.
- Keep the existing `bun.lock` file in sync when dependencies change.
- Do not use npm, npx, pnpm, yarn, or Node.js commands as substitutes for Bun.

The repository is a Bun workspace/monorepo. Run commands from the repository
root unless a package-specific command is required; use `bun --cwd <path> ...`
or change into that package directory when appropriate.
