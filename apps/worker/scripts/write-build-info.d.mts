/** Resolve the commit identity for a build: trusted env (BT_GIT_SHA/GIT_SHA)
 *  first, then the injected git lookup, then undefined. Exported for tests;
 *  the CLI entry (main guard) uses the defaults. */
export function resolveBuildSha(options?: {
  env?: Record<string, string | undefined>;
  git?: () => string | undefined;
}): string | undefined;
