/* =============================================================================
   @better-trigger/worker — HTTP listen wiring.

   One function, pulled out of main() for one reason: the bind address is the
   security decision this daemon makes (loopback by default, API unauthenticated
   unless BETTER_TRIGGER_API_KEY is set), and inside main() it sits behind a
   Postgres connection, so nothing could test it. Here it can be — see
   test/host.test.ts "bind address", which brings a real socket up and reads
   back what it bound to.

   `host` is required on purpose: `serve()` treats `hostname` as optional and
   silently listens on every interface without it, which is exactly the bug this
   file exists to prevent.
   ============================================================================= */
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { Hono } from 'hono';
import type { Env } from 'hono';

export interface ListenOptions {
  /** TCP port. 0 asks the OS for a free one (tests). */
  port: number;
  /** Bind address — never omitted; see the file header. */
  host: string;
}

/** Start the HTTP server on exactly `opts.host`:`opts.port`. */
export function startHttpServer<E extends Env>(
  app: Hono<E>,
  opts: ListenOptions,
  onListening?: (info: AddressInfo) => void,
): ServerType {
  return serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, onListening);
}
