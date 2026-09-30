// Deep enough for any real tree; a longer chain is treated as unresolved.
export const MAX_ANCESTRY_DEPTH = 64

// A directory's parent as far as the caller knows: its uuid, null once the walk has reached the top it
// needs, undefined when unknown.
export type ParentLookup = (uuid: string) => string | null | undefined

// Whether `uuid` is one of `dirUuids` or lies below one, walking `parentOf` upward. A chain that comes
// from a route only proves which directories hold its end, never which don't (a directory opened from
// search, Favorites or a pasted link starts a fresh one), so this is the absence check. "unresolved"
// when a link is missing, loops or runs too deep.
export function ancestryHits(uuid: string, dirUuids: ReadonlySet<string>, parentOf: ParentLookup): boolean | "unresolved" {
	let current = uuid

	for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
		if (dirUuids.has(current)) {
			return true
		}

		const parent = parentOf(current)

		if (parent === null) {
			return false
		}

		if (parent === undefined || parent === current) {
			return "unresolved"
		}

		current = parent
	}

	return "unresolved"
}
