/**
 * @module runtime
 * Client-side entry point for the Bolt runtime.
 *
 * Exposes a `Promise<RuntimeProvider>` singleton that resolves once
 * the runtime is booted. All stores and components import `runtime`
 * from this module.
 *
 * Usage:
 * ```ts
 * import { runtime } from '~/lib/runtime';
 * const rt = await runtime;
 * await rt.fs.writeFile('index.js', 'console.log("hello")');
 * ```
 *
 * The runtime is lazily booted on first access. The project ID is set
 * via `setProjectId()` before the runtime is used (typically in the
 * chat route loader or component mount).
 */

import type { RuntimeProvider } from './runtime-provider';
import { RuntimeClient } from './runtime-client';
import { createScopedLogger } from '~/utils/logger';
import { workbenchStore } from '~/lib/stores/workbench';

const logger = createScopedLogger('Runtime');

/*
 * ---------------------------------------------------------------------------
 * Runtime Context (HMR-safe, mirrors webcontainerContext pattern)
 * ---------------------------------------------------------------------------
 */

interface RuntimeContext {
  loaded: boolean;
  projectId: string | null;
}

export const runtimeContext: RuntimeContext = import.meta.hot?.data.runtimeContext ?? {
  loaded: false,
  projectId: null,
};

if (import.meta.hot) {
  import.meta.hot.data.runtimeContext = runtimeContext;
}

/*
 * ---------------------------------------------------------------------------
 * Singleton & Factory
 * ---------------------------------------------------------------------------
 */

let runtimeInstance: RuntimeClient | null = (import.meta.hot?.data.runtimeInstance as RuntimeClient | null) ?? null;

let runtimePromise: Promise<RuntimeProvider> | null =
  (import.meta.hot?.data.runtimePromise as Promise<RuntimeProvider> | null) ?? null;

let bootResolver: ((runtime: RuntimeProvider) => void) | null = null;

/**
 * Guard promise that prevents `bootRuntime()` from racing with an
 * in-progress `teardownCurrentRuntime()`.  When non-null, a teardown
 * is still running and callers must await it before proceeding.
 */
let teardownInProgress: Promise<void> | null = null;

/**
 * The runtime promise — resolves to a {@link RuntimeProvider} once booted.
 *
 * ```ts
 * const rt = await runtime;
 * await rt.fs.writeFile('index.js', 'console.log("hello")');
 * ```
 */
export let runtime: Promise<RuntimeProvider> = new Promise(() => {
  // No-op for SSR — same pattern as webcontainer singleton
});

if (!import.meta.env.SSR) {
  if (runtimeInstance && runtimeContext.loaded) {
    /*
     * Runtime already booted (HMR reload) — resolve immediately so all
     * stores that hold the runtime promise get the existing instance.
     */
    runtime = Promise.resolve(runtimeInstance);
  } else {
    /*
     * Fresh load or HMR before boot — create a pending promise.
     * bootResolver MUST always be connected so bootRuntime() can resolve it.
     * (The old code re-used a stale HMR-cached promise without reconnecting
     * bootResolver, causing the promise to hang forever after HMR.)
     */
    runtime = new Promise<RuntimeProvider>((resolve) => {
      bootResolver = resolve;
    });
  }

  runtimePromise = runtime;

  if (import.meta.hot) {
    import.meta.hot.data.runtimeInstance = runtimeInstance;
    import.meta.hot.data.runtimePromise = runtimePromise;
  }
}

/**
 * Set the project ID and boot the runtime.
 *
 * Call this when a chat session is loaded or created. The runtime
 * will create/open the project directory on the server.
 *
 * @param projectId - Unique identifier for the project (chat ID or similar)
 */
export async function bootRuntime(projectId: string): Promise<RuntimeProvider> {
  /*
   * Wait for any in-progress teardown to complete before booting so the old
   * runtime's ports are fully released and don't cause port escalation.
   */
  if (teardownInProgress) {
    logger.debug('Waiting for in-progress teardown before booting...');
    await teardownInProgress;
  }

  // If already booted for this project, return existing instance
  if (runtimeInstance && runtimeContext.projectId === projectId && runtimeContext.loaded) {
    logger.debug(`Runtime already booted for project "${projectId}"`);
    return runtimeInstance;
  }

  // If switching projects, tear down the old one
  if (runtimeInstance && runtimeContext.projectId !== projectId) {
    logger.info(`Switching runtime from "${runtimeContext.projectId}" to "${projectId}"`);
    await runtimeInstance.teardown();
    workbenchStore.resetPreviews();
    runtimeInstance = null;
    runtimeContext.loaded = false;
  }

  // Create and boot
  runtimeInstance = new RuntimeClient();

  try {
    await runtimeInstance.boot(projectId);
    runtimeContext.loaded = true;
    runtimeContext.projectId = projectId;

    logger.info(`Runtime booted for project "${projectId}"`);

    // Resolve the pending promise so `await runtime` unblocks
    if (bootResolver) {
      bootResolver(runtimeInstance);
      bootResolver = null;
    }

    // Update the module-level promise for future imports
    runtime = Promise.resolve(runtimeInstance);
    runtimePromise = runtime;

    if (import.meta.hot) {
      import.meta.hot.data.runtimeInstance = runtimeInstance;
      import.meta.hot.data.runtimePromise = runtimePromise;
    }

    return runtimeInstance;
  } catch (error) {
    logger.error(`Failed to boot runtime for "${projectId}":`, error);
    runtimeInstance = null;
    throw error;
  }
}

/**
 * Get the current runtime instance (already booted).
 * Returns `null` if the runtime hasn't been booted yet.
 */
export function getRuntimeInstance(): RuntimeClient | null {
  return runtimeInstance;
}

/**
 * Tear down the current runtime and reset module-level state.
 *
 * Call this when leaving a chat (e.g. navigating to the homepage)
 * so that the old WebContainer / dev-server process is stopped and
 * ports are freed.  `bootRuntime()` already calls teardown internally
 * when *switching* projects, but this function covers the case where
 * no new project is booted immediately after.
 */
export async function teardownCurrentRuntime(): Promise<void> {
  /*
   * If teardown is already in progress, return the existing promise to
   * deduplicate concurrent calls (cleanup useEffect + bootRuntime race).
   */
  if (teardownInProgress) {
    await teardownInProgress;

    return;
  }

  if (!runtimeInstance) {
    return;
  }

  const instance = runtimeInstance;
  const projectId = runtimeContext.projectId;

  logger.info(`Tearing down runtime for project "${projectId}"`);

  teardownInProgress = (async () => {
    try {
      await instance.teardown();
    } catch (error) {
      logger.error(`Runtime teardown failed for "${projectId}":`, error);
    }

    runtimeInstance = null;
    runtimeContext.loaded = false;
    runtimeContext.projectId = null;

    if (import.meta.hot) {
      import.meta.hot.data.runtimeInstance = null;
    }
  })();

  try {
    await teardownInProgress;
  } finally {
    teardownInProgress = null;
  }
}

/**
 * Get the current project ID.
 */
export function getCurrentProjectId(): string | null {
  return runtimeContext.projectId;
}
