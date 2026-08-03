// Whole-statement `import type` (not the usual inline `type` keyword — see lib/cache.ts): the inline
// form doesn't reliably elide under vitest for this package, and a non-elided import drags in the
// wasm-bindgen worker glue (references `self`, undefined under Node).
import type { SharedDir, SharedRootDir } from "@filen/sdk-rs"
import type { SharedDirContext } from "@/features/drive/lib/cache"

// Injected rather than imported so this stays worker-safe and node-testable: the worker binds them to
// its live Client + its own in-memory context map.
export interface SharedPathDeps {
	getContext: (uuid: string) => SharedDirContext | undefined
	listRootDirs: () => Promise<readonly SharedRootDir[]>
	cacheRootContexts: (dirs: readonly SharedRootDir[]) => void
	listChildDirs: (context: SharedDirContext) => Promise<readonly SharedDir[]>
	cacheChildContext: (uuid: string, context: SharedDirContext) => void
}

// Resolves the dir+role handle listSharedDir needs for a nested shared directory, re-walking the
// ancestor chain when the in-session context map has never seen it (a fresh worker after a reload,
// bookmark, restored tab or pasted URL — the map is worker memory only). `path` is the route splat's
// full ancestor-uuid chain, the target itself last. Returns undefined when the chain can't be walked
// (no hint, a mismatched path, or a segment the account can no longer reach) — the caller then throws
// the same not-found error it always did.
export async function resolveSharedDirContext(
	deps: SharedPathDeps,
	uuid: string,
	path: readonly string[]
): Promise<SharedDirContext | undefined> {
	const cached = deps.getContext(uuid)

	// The warm path pays nothing — no dep is touched at all.
	if (cached !== undefined) {
		return cached
	}

	if (path.length === 0 || path[path.length - 1] !== uuid) {
		return undefined
	}

	// Every shared ROOT dir carries its own role, so one root listing seeds the chain's first segment.
	deps.cacheRootContexts(await deps.listRootDirs())

	const ancestors = path.slice(0, -1)

	for (let index = 0; index < ancestors.length; index++) {
		const nextUuid = path[index + 1]

		// A partially warm map costs no round trip: if the NEXT segment already resolves, this one's
		// children never need listing.
		if (nextUuid !== undefined && deps.getContext(nextUuid) !== undefined) {
			continue
		}

		const segment = ancestors[index]

		if (segment === undefined) {
			return undefined
		}

		const context = deps.getContext(segment)

		if (context === undefined) {
			return undefined
		}

		// A nested SharedDir carries no role of its own — it inherits the share it was reached through.
		for (const child of await deps.listChildDirs(context)) {
			deps.cacheChildContext(child.inner.uuid, { dir: child, role: context.role })
		}
	}

	return deps.getContext(uuid)
}
