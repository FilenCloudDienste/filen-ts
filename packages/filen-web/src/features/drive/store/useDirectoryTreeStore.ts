import { create } from "zustand"

// Persisted open/closed state for the sidebar Cloud Drive tree: a uuid-keyed map (the drive root
// rides its own sentinel key — see directoryTree.tsx), each entry `true` when that node is expanded.
// Persisted so expansion survives navigation and reloads. Toggling ONE node only ever flips its own
// key — collapsing the root never wipes the descendants' recorded state (an old-web bug this design
// forecloses): a re-expand restores exactly the branch the user last left open.
const STORAGE_KEY = "driveTreeOpen"

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
			if (typeof value === "boolean") {
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
	toggle: (uuid: string) => void
}

export const useDirectoryTreeStore = create<DirectoryTreeState>(set => ({
	open: readInitial(),
	toggle: (uuid: string) => {
		set(state => {
			const next = { ...state.open, [uuid]: !state.open[uuid] }

			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
			} catch {
				// Persistence best-effort — the in-memory toggle still applies for this session.
			}

			return { open: next }
		})
	}
}))
