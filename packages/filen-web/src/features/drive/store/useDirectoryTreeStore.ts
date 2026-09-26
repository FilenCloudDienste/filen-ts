import { create } from "zustand"

// Persisted open/closed state for the sidebar Cloud Drive tree: a uuid-keyed map, the drive root riding
// its own sentinel key. Persisted so expansion survives navigation and reloads. Toggling ONE node only
// ever flips its own key — collapsing the root never wipes the descendants' recorded state (an old-web
// bug this design forecloses): a re-expand restores exactly the branch the user last left open.
//
// Only states that differ from a node's default are stored: a collapsed root as `false`, an expanded
// directory as its parent's key. The parent is what lets a level that loads its children drop the
// entries of directories no longer among them (deleted or moved away), and theirs below, so the map
// stays as small as what is open.
const STORAGE_KEY = "driveTreeOpen"

// The Cloud Drive root row's key, and the parent key of its children. Directory keys are real UUIDs,
// never the literal "root".
export const TREE_ROOT_KEY = "root"

// An expanded directory's parent key (`true` when saved by a build that didn't record it, adopted the
// first time its level loads), or `false` for the collapsed root.
export type TreeEntries = Record<string, string | boolean>

// The root starts expanded so the tree reads as present; every directory starts collapsed.
function defaultOpen(key: string): boolean {
	return key === TREE_ROOT_KEY
}

export function isTreeNodeOpen(entries: Readonly<TreeEntries>, key: string): boolean {
	const entry = entries[key]

	return entry === undefined ? defaultOpen(key) : entry !== false
}

export function toggleTreeEntry(entries: Readonly<TreeEntries>, key: string, parentKey: string): TreeEntries {
	const nextOpen = !isTreeNodeOpen(entries, key)
	const next = Object.fromEntries(Object.entries(entries).filter(([entryKey]) => entryKey !== key))

	if (nextOpen !== defaultOpen(key)) {
		next[key] = nextOpen ? parentKey : false
	}

	return next
}

// A level under `parentKey` loaded `childKeys`: entries recorded under it for any other directory go,
// with every entry below them, and entries without a recorded parent adopt this one. Returns the same
// object when nothing changes.
export function reconcileTreeLevel(entries: Readonly<TreeEntries>, parentKey: string, childKeys: readonly string[]): Readonly<TreeEntries> {
	const children = new Set(childKeys)
	const removed = new Set<string>()
	let adopted = false

	for (const [key, entry] of Object.entries(entries)) {
		if (entry === parentKey && !children.has(key)) {
			removed.add(key)
		} else if (entry === true && children.has(key)) {
			adopted = true
		}
	}

	if (removed.size === 0 && !adopted) {
		return entries
	}

	// Cascade: an entry whose parent went goes too, until a pass removes nothing.
	for (let grew = removed.size > 0; grew;) {
		grew = false

		for (const [key, entry] of Object.entries(entries)) {
			if (typeof entry === "string" && removed.has(entry) && !removed.has(key)) {
				removed.add(key)
				grew = true
			}
		}
	}

	const next: TreeEntries = {}

	for (const [key, entry] of Object.entries(entries)) {
		if (!removed.has(key)) {
			next[key] = entry === true && children.has(key) ? parentKey : entry
		}
	}

	return next
}

function readInitial(): TreeEntries {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)

		if (raw === null) {
			return {}
		}

		const parsed: unknown = JSON.parse(raw)

		if (typeof parsed !== "object" || parsed === null) {
			return {}
		}

		// Rebuild defensively rather than trust the blob's shape — a hand-edited or version-skewed value
		// must never inject other entries into the map. Also sheds entries an older build saved at their
		// default.
		const out: TreeEntries = {}
		const stored: [string, unknown][] = Object.entries(parsed)

		for (const [key, value] of stored) {
			if (key === TREE_ROOT_KEY) {
				if (value === false) {
					out[key] = false
				}
			} else if (value === true || (typeof value === "string" && value.length > 0)) {
				out[key] = value
			}
		}

		return out
	} catch {
		// Private-mode / disabled storage or malformed JSON — start collapsed; state stays in-memory.
		return {}
	}
}

function persist(entries: Readonly<TreeEntries>): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
	} catch {
		// Persistence best-effort — the in-memory state still applies for this session.
	}
}

interface DirectoryTreeState {
	open: Readonly<TreeEntries>
	toggle: (key: string, parentKey: string) => void
	reconcileLevel: (parentKey: string, childKeys: readonly string[]) => void
}

export const useDirectoryTreeStore = create<DirectoryTreeState>((set, get) => ({
	open: readInitial(),
	toggle: (key, parentKey) => {
		const next = toggleTreeEntry(get().open, key, parentKey)

		persist(next)
		set({ open: next })
	},
	reconcileLevel: (parentKey, childKeys) => {
		const current = get().open
		const next = reconcileTreeLevel(current, parentKey, childKeys)

		if (next !== current) {
			persist(next)
			set({ open: next })
		}
	}
}))

// Logout: the uuids are the signed-out account's, so the next sign-in starts from the defaults.
export function clearDirectoryTreeState(): void {
	try {
		localStorage.removeItem(STORAGE_KEY)
	} catch {
		// Storage unavailable — nothing was persisted.
	}

	useDirectoryTreeStore.setState({ open: {} })
}
