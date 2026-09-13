import { AsyncLocalStorage } from 'node:async_hooks';

export type KernelEnvironment = Readonly<Record<string, string | undefined>>;

// Kernel methods, their transactions, and orchestrator timers inherit the
// owning kernel's configuration. Independent embedded kernels never mutate
// process.env or overwrite one another's limits while operations overlap.
const environment = new AsyncLocalStorage<KernelEnvironment>();

export function withKernelEnvironment<T>(env: KernelEnvironment, operation: () => T): T {
  return environment.run(env, operation);
}

export function kernelEnvironment(): KernelEnvironment {
  return environment.getStore() ?? process.env;
}
