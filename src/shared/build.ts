declare const __PR_BUILD_ID__: string | undefined;

/**
 * Build timestamp (ms) stamped into both bundles by scripts/build.mjs, or 0 when
 * running unbundled (tests). Lets a window replace a service left running by an
 * older build of the extension.
 */
export const BUILD_ID: number = typeof __PR_BUILD_ID__ === 'string' ? Number(__PR_BUILD_ID__) : 0;
