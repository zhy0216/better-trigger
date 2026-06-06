/* =============================================================================
   better-trigger — SDK configuration.
   Resolves the server URL + API key from explicit configure() calls or the
   BETTER_TRIGGER_API_URL / BETTER_TRIGGER_API_KEY environment variables.
   ============================================================================= */

export interface SdkConfig {
  /** Base URL of the better-trigger server, e.g. "http://localhost:4848". */
  apiUrl: string;
  /** Bearer API key. Empty when the server runs in local unauthenticated mode. */
  apiKey: string;
}

export const DEFAULT_API_URL = 'http://localhost:4848';

/** Explicit overrides set via configure(); take precedence over env. */
let overrides: Partial<SdkConfig> = {};

/** Configure the SDK programmatically. Values override the environment. */
export function configure(config: Partial<SdkConfig>): void {
  overrides = { ...overrides, ...config };
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Resolve the active config, optionally merging per-call overrides
 * (e.g. startWorker({ apiUrl, apiKey })).
 */
export function resolveConfig(perCall?: Partial<SdkConfig>): SdkConfig {
  const apiUrl =
    perCall?.apiUrl ??
    overrides.apiUrl ??
    readEnv('BETTER_TRIGGER_API_URL') ??
    DEFAULT_API_URL;
  const apiKey =
    perCall?.apiKey ?? overrides.apiKey ?? readEnv('BETTER_TRIGGER_API_KEY') ?? '';
  return { apiUrl: stripTrailingSlash(apiUrl), apiKey };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
