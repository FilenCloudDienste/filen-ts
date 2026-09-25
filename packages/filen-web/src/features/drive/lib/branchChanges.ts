import { type ParentLookup } from "@/features/drive/components/moveTargetDialog.logic"
import { type DriveVariant } from "@/features/drive/lib/preferences"

// A directory that left its place: moved (here, from the sidebar tree, or on another device) or trashed.
// The drive route is a uuid chain, so one of its directories moving or going to the trash leaves the
// route naming a place that no longer exists; the listing on screen re-routes off these.
export type BranchChange = { type: "moved"; uuid: string; parentUuid: string | null } | { type: "trashed"; uuid: string }

type Listener = (change: BranchChange) => void

const listeners = new Set<Listener>()

export function subscribeBranchChanges(listener: Listener): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

export function emitBranchChange(change: BranchChange): void {
	for (const listener of listeners) {
		listener(change)
	}
}

// Deep enough for any real tree; a longer chain is treated as unresolved.
const MAX_CHAIN_DEPTH = 64

// `uuid`'s root-to-directory chain as the cached listings record it, undefined when a link is missing.
function ownChain(uuid: string, parentOf: ParentLookup): string[] | undefined {
	const chain = [uuid]
	let current = uuid

	for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
		const parent = parentOf(current)

		if (parent === null) {
			return chain.reverse()
		}

		if (parent === undefined || chain.includes(parent)) {
			return undefined
		}

		chain.push(parent)
		current = parent
	}

	return undefined
}

// Where a route should go once a directory on it changed, or null when it is unaffected. A trashed one
// leaves its parent's chain; a moved one keeps its own tail under its new parent's chain, or starts a
// fresh chain at itself (as a directory opened from search does) when the cache can't say where that is.
// Parents are only read for a move that hits the route.
export function reroutedPath(path: readonly string[], change: BranchChange, readParents: () => ParentLookup): string[] | null {
	const index = path.indexOf(change.uuid)

	if (index === -1) {
		return null
	}

	if (change.type === "trashed") {
		return path.slice(0, index)
	}

	const parentChain = change.parentUuid === null ? [] : ownChain(change.parentUuid, readParents())
	const next = [...(parentChain ?? []), ...path.slice(index)]

	return next.length === path.length && next.every((uuid, position) => uuid === path[position]) ? null : next
}

export interface BranchRoute {
	to: "/drive/$" | "/shared-out/$"
	path: string[]
}

// reroutedPath for the listing on screen. My Drive and Shared by me are the routes made of the user's own
// directories; no other listing has a chain the tree can change. Under Shared by me the shared directory
// itself stays shared wherever it moves, and one below it stays in the share only when it moved under a
// directory the route already holds; otherwise it left the share, and the route follows it into My Drive.
export function reroutedRoute(
	variant: DriveVariant,
	path: readonly string[],
	change: BranchChange,
	readParents: () => ParentLookup
): BranchRoute | null {
	if (variant === "drive") {
		const next = reroutedPath(path, change, readParents)

		return next === null ? null : { to: "/drive/$", path: next }
	}

	const index = variant === "sharedOut" ? path.indexOf(change.uuid) : -1

	if (index === -1) {
		return null
	}

	if (change.type === "trashed") {
		return { to: "/shared-out/$", path: path.slice(0, index) }
	}

	const parentIndex = change.parentUuid === null ? -1 : path.indexOf(change.parentUuid)

	if (index === 0 || parentIndex === index - 1) {
		return null
	}

	if (parentIndex !== -1 && parentIndex < index) {
		return { to: "/shared-out/$", path: [...path.slice(0, parentIndex + 1), ...path.slice(index)] }
	}

	const next = reroutedPath(path, change, readParents)

	return next === null ? null : { to: "/drive/$", path: next }
}
