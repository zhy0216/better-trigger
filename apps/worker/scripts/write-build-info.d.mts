export interface GitOptions {
  git?: (args: string[]) => string;
}

export interface BuildShaOptions {
  env?: Record<string, string | undefined>;
  git?: () => string | undefined;
}

export interface BuildInfoOptions extends BuildShaOptions {
  root?: string;
}

export function defaultGitSha(options?: GitOptions): string | undefined;
export function resolveBuildSha(options?: BuildShaOptions): string | undefined;
export function resolveBuildInfo(options?: BuildInfoOptions): {
  version: string;
  sha: string | undefined;
};
