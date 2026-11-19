import { type } from "arktype"
import { create } from "zustand"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"

// Persisted open/closed state for the sidebar Cloud Drive tree: a uuid-keyed map, the drive root riding
// its own sentinel key. Kept in the kv store, read during boot (lib/sdk/boot.ts) before the sidebar first
// renders, so expansion survives navigation and reloads and the logout kv wipe owns it. Toggling ONE node only
// ever flips its own key — collapsing the root never wipes the descendants' recorded state (an old-web
// bug this design forecloses): a re-expand restores exactly the branch the user last left open.
//
// Only states that differ from a node's default are stored: a collapsed root as `false`, an expanded
// directory as its parent's key. The parent is what lets a level that loads its children drop the
// entries of directories no longer among them (deleted or moved away), and theirs below, so the map
// stays as small as what is open.
const KV_KEY = "drive.treeOpen.v1"
const storedSchema = type("Record<string, unknown>")

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

// Rebuild defensively rather than trust the stored shape: a version-skewed value must never inject other
// entries into the map. Also sheds entries saved at their default.
function sanitize(stored: Readonly<Record<string, unknown>>): TreeEntries {
	const out: TreeEntries = {}

	for (const [key, value] of Object.entries(stored)) {
		if (key === TREE_ROOT_KEY) {
			if (value === false) {
				out[key] = false
			}
		} else if (value === true || (typeof value === "string" && value.length > 0)) {
			out[key] = value
		}
	}

	return out
}

// Shown at once; stored in the background (a failed write is logged and the state holds for this session).
function persist(entries: Readonly<TreeEntries>): void {
	kvSetJson(KV_KEY, entries).catch((error: unknown) => {
		log.warn("drive", "tree state not saved", { error })
	})
}

interface DirectoryTreeState {
	open: Readonly<TreeEntries>
	toggle: (key: string, parentKey: string) => void
	reconcileLevel: (parentKey: string, childKeys: readonly string[]) => void
}

export const useDirectoryTreeStore = create<DirectoryTreeState>((set, get) => ({
	open: {},
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

// Boot (lib/sdk/boot.ts): reads the stored map once; never rejects (an unreadable one leaves the defaults).
export async function loadDirectoryTreeOpen(): Promise<void> {
	try {
		const stored = await kvGetJson(KV_KEY, storedSchema)

		if (stored !== null) {
			useDirectoryTreeStore.setState({ open: sanitize(stored) })
		}
	} catch (error) {
		log.warn("drive", "tree state not read", { error })
	}
}

// Logout: the uuids are the signed-out account's, so the next sign-in starts from the defaults. Memory only:
// the logout kv wipe owns the stored row, and a write from here could land after it.
export function clearDirectoryTreeState(): void {
	useDirectoryTreeStore.setState({ open: {} })
}
