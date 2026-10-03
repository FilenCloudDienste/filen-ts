import type { ArchiveEntry } from "@filen/sdk-rs"
import {
	ENTRY_FLAG,
	ENTRY_KIND,
	skipCode,
	type PackedEntryBatch,
	type PackedEntryLink,
	type PackedStoredPath
} from "@/lib/sdk/archiveListing"

export interface ListBatcher {
	push: (entries: ArchiveEntry[]) => void
	// Posts what is buffered, if anything.
	flush: () => void
	pending: () => number
}

// Packs a listing's entries into PackedEntryBatches of up to `flushAt`. The builder columns are
// allocated once; a flush posts trimmed copies, so the builder is reused and only the copies clone.
export function createListBatcher(deliver: (batch: PackedEntryBatch) => void, flushAt = 4096): ListBatcher {
	const index = new Uint32Array(flushAt)
	const kind = new Uint8Array(flushAt)
	const skip = new Uint8Array(flushAt)
	const flags = new Uint8Array(flushAt)
	const size = new Float64Array(flushAt)
	const modified = new Float64Array(flushAt)
	const parent = new Uint32Array(flushAt)
	const parentOf = new Map<string, number>()
	let archive = ""
	let count = 0
	let name: string[] = []
	let parents: string[] = []
	let links: PackedEntryLink[] = []
	let stored: PackedStoredPath[] = []

	function parentIndex(path: string): number {
		let found = parentOf.get(path)

		if (found === undefined) {
			found = parents.length

			parents.push(path)
			parentOf.set(path, found)
		}

		return found
	}

	function add(entry: ArchiveEntry): void {
		const i = count
		let path = entry.path?.path ?? ""
		let end = path.length

		while (end > 0 && path.charCodeAt(end - 1) === 47) {
			end--
		}

		if (end < path.length) {
			path = path.slice(0, end)
		}

		let bits = (entry.encrypted ? ENTRY_FLAG.encrypted : 0) | (entry.macMetadata ? ENTRY_FLAG.macMetadata : 0)

		if (entry.storedPathTruncated) {
			bits |= ENTRY_FLAG.storedTruncated
		}

		if (entry.path === undefined || path === "") {
			bits |= ENTRY_FLAG.pathless
			parent[i] = parentIndex("")

			name.push(entry.storedPath)
		} else {
			const slash = path.lastIndexOf("/")

			if (entry.path.rewritten) {
				bits |= ENTRY_FLAG.rewritten
			}

			if (entry.path.misleading) {
				bits |= ENTRY_FLAG.misleading
			}

			parent[i] = parentIndex(slash < 0 ? "" : path.slice(0, slash))

			name.push(slash < 0 ? path : path.slice(slash + 1))
		}

		archive = entry.id.archive
		index[i] = entry.id.index
		kind[i] = ENTRY_KIND[entry.kind.type]
		skip[i] = entry.skip === undefined ? 0 : skipCode(entry.skip.type)
		flags[i] = bits
		size[i] = entry.size === undefined ? -1 : Number(entry.size)
		modified[i] = entry.modified === undefined ? NaN : Number(entry.modified)

		if (entry.kind.type === "symlink") {
			links.push({ i, target: entry.kind.target, targetIndex: -1 })
		} else if (entry.kind.type === "hardlink") {
			links.push({ i, target: entry.kind.target, targetIndex: entry.kind.targetId?.index ?? -1 })
		}

		if ((bits & (ENTRY_FLAG.rewritten | ENTRY_FLAG.pathless | ENTRY_FLAG.storedTruncated)) !== 0) {
			stored.push({ i, storedPath: entry.storedPath })
		}

		count++
	}

	function flush(): void {
		if (count === 0) {
			return
		}

		const batch: PackedEntryBatch = {
			archive,
			count,
			index: index.slice(0, count),
			kind: kind.slice(0, count),
			skip: skip.slice(0, count),
			flags: flags.slice(0, count),
			size: size.slice(0, count),
			modified: modified.slice(0, count),
			name,
			parent: parent.slice(0, count),
			parents,
			links,
			stored
		}

		count = 0
		name = []
		parents = []
		links = []
		stored = []

		parentOf.clear()
		deliver(batch)
	}

	return {
		push: entries => {
			for (const entry of entries) {
				add(entry)

				if (count === flushAt) {
					flush()
				}
			}
		},
		flush,
		pending: () => count
	}
}
