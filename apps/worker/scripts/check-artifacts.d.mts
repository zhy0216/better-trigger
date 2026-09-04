export interface ArtifactGraphOptions {
  distDir: string;
  entries: string[];
  requirePublic?: boolean;
}

export interface ArtifactCheckOptions {
  root?: string;
  packFiles?: string[];
  expectedSha?: string;
  rejectShas?: string[];
}

export function checkArtifactGraph(options: ArtifactGraphOptions): {
  files: string[];
  reachable: Set<string>;
};
export function parsePackList(output: string): string[];
export function checkArtifacts(options?: ArtifactCheckOptions): {
  files: string[];
  packed: string[];
};
