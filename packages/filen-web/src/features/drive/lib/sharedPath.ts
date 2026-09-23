// Whole-statement `import type` (not the usual inline `type` keyword — see lib/cache.ts): the inline
// form doesn't reliably elide under vitest for this package, and a non-elided import drags in the
// wasm-bindgen worker glue (references `self`, undefined under Node).
import type { SharedDir, SharedRootDir } from "@filen/sdk-rs"
import { InFlight } from "@filen/shared"
import type { SharedDirContext } from "@/features/drive/lib/cache"

// Which shared surface a uuid's ancestor chain should be re-walked through — the route splat's own
// variant, since a uuid alone cannot say whether it was reached via shared-in or shared-out. `path` is
// the splat's ancestor-uuid chain, the uuid itself last.
export interface SharedPathHint {
	variant: "sharedIn" | "sharedOut"
	path: string[]
}

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

	// Every shared ROOT dir carries its own role, so one root listing seeds the chain's first segment —
	// needed only while that segment is still unknown.
	const first = path[0]

	if (first === undefined || deps.getContext(first) === undefined) {
		deps.cacheRootContexts(await deps.listRootDirs())
	}

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

		cacheChildContexts(deps, context, await deps.listChildDirs(context))
	}

	return deps.getContext(uuid)
}

// A nested SharedDir carries no role of its own — it inherits the share it was reached through.
function cacheChildContexts(deps: SharedPathDeps, parent: SharedDirContext, children: readonly SharedDir[]): void {
	for (const child of children) {
		deps.cacheChildContext(child.inner.uuid, { dir: child, role: parent.role })
	}
}

// One in-flight root listing and one in-flight child listing per directory, per client and variant.
export interface SharedPathInFlight {
	roots: InFlight<"roots", readonly SharedRootDir[]>
	children: InFlight<string, readonly SharedDir[]>
}

export function createSharedPathInFlight(): SharedPathInFlight {
	return { roots: new InFlight(), children: new InFlight() }
}

// A cold deep URL starts several walks over the same chain at once (the listing plus one per
// breadcrumb crumb). Sharing each in-flight listing between them keeps the cost at one request per
// chain level however many walks reach it. Each result is cached before its in-flight entry clears, so
// a walk arriving in between finds it in the context map instead of listing again.
export function coalesceSharedPathDeps(deps: SharedPathDeps, inFlight: SharedPathInFlight): SharedPathDeps {
	return {
		...deps,
		listRootDirs: () =>
			inFlight.roots.coalesce("roots", async () => {
				const dirs = await deps.listRootDirs()

				deps.cacheRootContexts(dirs)

				return dirs
			}),
		listChildDirs: context =>
			inFlight.children.coalesce(context.dir.inner.uuid, async () => {
				const dirs = await deps.listChildDirs(context)

				cacheChildContexts(deps, context, dirs)

				return dirs
			})
	}
}
