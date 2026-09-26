import { create } from "zustand"

// Persisted open/closed state for the sidebar Cloud Drive tree: a uuid-keyed map, the drive root riding
// its own sentinel key. Persisted so expansion survives navigation and reloads. Toggling ONE node only
// ever flips its own key — collapsing the root never wipes the descendants' recorded state (an old-web
// bug this design forecloses): a re-expand restores exactly the branch the user last left open.
//
// Only states that differ from a node's default are stored (an expanded directory, a collapsed root),
// so collapsing removes the entry again and the map stays as small as what is open.
const STORAGE_KEY = "driveTreeOpen"

// The Cloud Drive root row's key. Directory keys are real UUIDs, never the literal "root".
export const TREE_ROOT_KEY = "root"

// The root starts expanded so the tree reads as present; every directory starts collapsed.
function defaultOpen(key: string): boolean {
	return key === TREE_ROOT_KEY
}

export function isTreeNodeOpen(open: Readonly<Record<string, boolean>>, key: string): boolean {
	return open[key] ?? defaultOpen(key)
}

function readInitial(): Record<string, boolean> {
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
		// must never inject non-boolean entries into the map.
		const out: Record<string, boolean> = {}

		for (const [key, value] of Object.entries(parsed)) {
			// Also sheds entries an older build saved at their default.
			if (typeof value === "boolean" && value !== defaultOpen(key)) {
				out[key] = value
			}
		}

		return out
	} catch {
		// Private-mode / disabled storage or malformed JSON — start collapsed; state stays in-memory.
		return {}
	}
}

interface DirectoryTreeState {
	open: Record<string, boolean>
	toggle: (key: string) => void
}

export const useDirectoryTreeStore = create<DirectoryTreeState>(set => ({
	open: readInitial(),
	toggle: (key: string) => {
		set(state => {
			const nextOpen = !isTreeNodeOpen(state.open, key)
			const next = Object.fromEntries(Object.entries(state.open).filter(([entryKey]) => entryKey !== key))

			if (nextOpen !== defaultOpen(key)) {
				next[key] = nextOpen
			}

			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
			} catch {
				// Persistence best-effort — the in-memory toggle still applies for this session.
			}

			return { open: next }
		})
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
