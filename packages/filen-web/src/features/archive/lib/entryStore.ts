import { ENTRY_FLAG, ENTRY_KIND, MISLEADING_CHARACTER, type PackedEntryBatch } from "@/lib/sdk/archiveListing"

// A listing's entries on the page, append-only. Entries live in chunked typed-array columns (a slot per
// entry, in arrival order), so growing never copies a column. Directories are nodes (0 the root), made
// for every directory a path implies whether or not the archive stores an entry for it, with subtree
// totals kept as batches arrive. A directory entry is no row of its own: it marks its node. Directory
// paths match as the SDK's extraction matches them, case-folded: two spellings are one directory, shown
// under the first, so a selection resolves to what an extract takes.

export const ENTRY_CHUNK_BITS = 12
export const ENTRY_CHUNK = 1 << ENTRY_CHUNK_BITS

const CHUNK_MASK = ENTRY_CHUNK - 1

export interface EntryLink {
	target: string
	// -1 for a symlink, or a hard link the SDK could not resolve.
	targetIndex: number
}

export interface EntryStore {
	// "" until the first batch.
	readonly archiveUuid: string
	// Bumped by every append.
	readonly version: number
	readonly entryCount: number
	readonly dirCount: number
	append: (batch: PackedEntryBatch) => void
	// Per entry slot.
	index: (slot: number) => number
	kind: (slot: number) => number
	skip: (slot: number) => number
	flags: (slot: number) => number
	// -1 when unknown (directories).
	size: (slot: number) => number
	// NaN when absent.
	modified: (slot: number) => number
	// The directory node holding it (a directory entry: the node above its own).
	parent: (slot: number) => number
	name: (slot: number) => string
	link: (slot: number) => EntryLink | undefined
	// Set only when the name is not the stored path.
	storedPath: (slot: number) => string | undefined
	// A solid 7z entry's skippedBytes and estimatedPackedBytes (accessOfFlags tells it is one); 0 otherwise.
	solidSkipped: (slot: number) => number
	solidEstimated: (slot: number) => number
	// Per directory node.
	dirParent: (id: number) => number
	dirName: (id: number) => string
	// -1 for a directory only implied by the paths below it.
	dirEntrySlot: (id: number) => number
	// Its entry's flags; for a directory only implied, misleading when its own name has a character the SDK
	// flags (which an implied directory's paths carry, but nothing of its own).
	dirFlags: (id: number) => number
	dirSkip: (id: number) => number
	dirModified: (id: number) => number
	childDirs: (id: number) => readonly number[]
	// Every non-directory entry directly in it, in arrival order.
	childEntries: (id: number) => readonly number[]
	// Unskipped files below it, hard links included, and their bytes.
	aggFiles: (id: number) => number
	aggBytes: (id: number) => number
	// Unskipped entries of any kind below it, its own included: what makes it selectable.
	aggEntries: (id: number) => number
	// -1 when there is none; any spelling of the path finds it.
	findDir: (path: string) => number
	// Its drive path, "/"-joined from the root ("" for the root): what an extract's `base` takes.
	dirPath: (id: number) => string
	// -1 when no entry has it.
	slotOfIndex: (index: number) => number
}

interface EntryChunk {
	index: Uint32Array
	kind: Uint8Array
	skip: Uint8Array
	flags: Uint8Array
	size: Float64Array
	modified: Float64Array
	parent: Int32Array
	// Allocated by the chunk's first solid 7z entry.
	solidSkipped: Float64Array | null
	solidEstimated: Float64Array | null
}

const NO_CHILDREN: readonly number[] = []

function newChunk(): EntryChunk {
	return {
		index: new Uint32Array(ENTRY_CHUNK),
		kind: new Uint8Array(ENTRY_CHUNK),
		skip: new Uint8Array(ENTRY_CHUNK),
		flags: new Uint8Array(ENTRY_CHUNK),
		size: new Float64Array(ENTRY_CHUNK),
		modified: new Float64Array(ENTRY_CHUNK),
		parent: new Int32Array(ENTRY_CHUNK),
		solidSkipped: null,
		solidEstimated: null
	}
}

// A copy that keeps no larger string alive: V8 serves a long `slice` as a view into its source, which
// would pin the whole path for as long as the name lives.
function ownString(value: string): string {
	return (" " + value).slice(1)
}

// The SDK's collision key (str::to_lowercase per segment); "/" folds to itself, so the whole path folds
// at once.
function dirKey(path: string): string {
	return path.toLowerCase()
}

export function createEntryStore(): EntryStore {
	const chunks: EntryChunk[] = []
	const names: string[] = []
	const links = new Map<number, EntryLink>()
	const storedPaths = new Map<number, string>()
	const dirParents: number[] = [-1]
	const dirNames: string[] = [""]
	const dirEntrySlots: number[] = [-1]
	const impliedDirFlags: number[] = [0]
	const childDirLists: (number[] | undefined)[] = [undefined]
	const childEntryLists: (number[] | undefined)[] = [undefined]
	const aggFileCounts: number[] = [0]
	const aggByteCounts: number[] = [0]
	const aggEntryCounts: number[] = [0]
	const pathToDir = new Map<string, number>([["", 0]])
	let archiveUuid = ""
	let version = 0
	let entryCount = 0
	let maxIndex = -1
	// slot by index, built on the first lookup the identity guess misses.
	let slotsByIndex: Int32Array | null = null
	let slotsIndexed = 0

	function chunkOf(slot: number): EntryChunk {
		const chunk = chunks[slot >>> ENTRY_CHUNK_BITS]

		if (chunk === undefined) {
			throw new Error(`entryStore: slot ${String(slot)} out of range`)
		}

		return chunk
	}

	function ensureDir(path: string): number {
		const key = dirKey(path)
		const found = pathToDir.get(key)

		if (found !== undefined) {
			return found
		}

		const slash = path.lastIndexOf("/")
		const parentId = slash < 0 ? 0 : ensureDir(path.slice(0, slash))
		const id = dirParents.length
		const name = ownString(slash < 0 ? path : path.slice(slash + 1))

		dirParents.push(parentId)
		dirNames.push(name)
		dirEntrySlots.push(-1)
		impliedDirFlags.push(MISLEADING_CHARACTER.test(name) ? ENTRY_FLAG.misleading : 0)
		childDirLists.push(undefined)
		childEntryLists.push(undefined)
		aggFileCounts.push(0)
		aggByteCounts.push(0)
		aggEntryCounts.push(0)
		pushChild(childDirLists, parentId, id)
		pathToDir.set(key, id)

		return id
	}

	function pushChild(lists: (number[] | undefined)[], id: number, child: number): void {
		const list = lists[id]

		if (list === undefined) {
			lists[id] = [child]
		} else {
			list.push(child)
		}
	}

	function addTotals(id: number, files: number, bytes: number, entries: number): void {
		for (let node = id; node >= 0; node = dirParents[node] ?? -1) {
			aggFileCounts[node] = (aggFileCounts[node] ?? 0) + files
			aggByteCounts[node] = (aggByteCounts[node] ?? 0) + bytes
			aggEntryCounts[node] = (aggEntryCounts[node] ?? 0) + entries
		}
	}

	function append(batch: PackedEntryBatch): void {
		const count = batch.count

		if (count === 0) {
			return
		}

		if (archiveUuid === "") {
			archiveUuid = batch.archive
		}

		const parentCount = batch.parents.length
		const parentIds = new Int32Array(parentCount)
		// Per parent, summed over the batch, then walked up once.
		const files = new Float64Array(parentCount)
		const bytes = new Float64Array(parentCount)
		const entries = new Float64Array(parentCount)

		for (let p = 0; p < parentCount; p++) {
			parentIds[p] = ensureDir(batch.parents[p] ?? "")
		}

		const base = entryCount

		for (let i = 0; i < count; i++) {
			const slot = base + i
			const offset = slot & CHUNK_MASK

			if (offset === 0) {
				chunks.push(newChunk())
			}

			const chunk = chunkOf(slot)
			const p = batch.parent[i] ?? 0
			const parentId = parentIds[p] ?? 0
			const kind = batch.kind[i] ?? ENTRY_KIND.other
			const skip = batch.skip[i] ?? 0
			const flags = batch.flags[i] ?? 0
			const size = batch.size[i] ?? -1
			const index = batch.index[i] ?? 0
			// Cloned across from the worker, so each is its own string.
			const name = batch.name[i] ?? ""

			chunk.index[offset] = index
			chunk.kind[offset] = kind
			chunk.skip[offset] = skip
			chunk.flags[offset] = flags
			chunk.size[offset] = size
			chunk.modified[offset] = batch.modified[i] ?? NaN
			chunk.parent[offset] = parentId

			if (batch.solid !== null) {
				const skipped = batch.solid.skipped[i] ?? 0
				const estimated = batch.solid.estimated[i] ?? 0

				if (skipped > 0 || estimated > 0) {
					chunk.solidSkipped ??= new Float64Array(ENTRY_CHUNK)
					chunk.solidEstimated ??= new Float64Array(ENTRY_CHUNK)
					chunk.solidSkipped[offset] = skipped
					chunk.solidEstimated[offset] = estimated
				}
			}

			names.push(name)

			if (index > maxIndex) {
				maxIndex = index
			}

			if (kind === ENTRY_KIND.dir && (flags & ENTRY_FLAG.pathless) === 0) {
				const parentPath = batch.parents[p] ?? ""
				const id = ensureDir(parentPath === "" ? name : `${parentPath}/${name}`)
				const earlier = dirEntrySlots[id] ?? -1
				// The same directory stored twice (in any spelling): the later entry replaces the earlier as the
				// node's own.
				const counted = (skip === 0 ? 1 : 0) - (earlier >= 0 && chunkOf(earlier).skip[earlier & CHUNK_MASK] === 0 ? 1 : 0)

				dirEntrySlots[id] = slot

				if (counted !== 0) {
					addTotals(id, 0, 0, counted)
				}

				continue
			}

			pushChild(childEntryLists, parentId, slot)

			if (skip === 0) {
				entries[p] = (entries[p] ?? 0) + 1

				if (kind === ENTRY_KIND.file || kind === ENTRY_KIND.hardlink) {
					files[p] = (files[p] ?? 0) + 1
					bytes[p] = (bytes[p] ?? 0) + Math.max(size, 0)
				}
			}
		}

		for (let p = 0; p < parentCount; p++) {
			const added = entries[p] ?? 0

			if (added > 0) {
				addTotals(parentIds[p] ?? 0, files[p] ?? 0, bytes[p] ?? 0, added)
			}
		}

		for (const link of batch.links) {
			links.set(base + link.i, { target: link.target, targetIndex: link.targetIndex })
		}

		for (const stored of batch.stored) {
			storedPaths.set(base + stored.i, stored.storedPath)
		}

		entryCount += count
		version++
	}

	function slotOfIndex(index: number): number {
		if (index < 0 || index > maxIndex) {
			return -1
		}

		// A listing usually arrives in index order, so the slot is the index.
		if (index < entryCount && chunkOf(index).index[index & CHUNK_MASK] === index) {
			return index
		}

		if (slotsByIndex === null || slotsByIndex.length <= maxIndex) {
			const grown = new Int32Array(maxIndex + 1).fill(-1)

			if (slotsByIndex !== null) {
				grown.set(slotsByIndex)
			}

			slotsByIndex = grown
		}

		for (; slotsIndexed < entryCount; slotsIndexed++) {
			slotsByIndex[chunkOf(slotsIndexed).index[slotsIndexed & CHUNK_MASK] ?? 0] = slotsIndexed
		}

		return slotsByIndex[index] ?? -1
	}

	function dirPath(id: number): string {
		const segments: string[] = []

		for (let node = id; node > 0; node = dirParents[node] ?? 0) {
			segments.push(dirNames[node] ?? "")
		}

		return segments.reverse().join("/")
	}

	return {
		get archiveUuid() {
			return archiveUuid
		},
		get version() {
			return version
		},
		get entryCount() {
			return entryCount
		},
		get dirCount() {
			return dirParents.length
		},
		append,
		index: slot => chunkOf(slot).index[slot & CHUNK_MASK] ?? 0,
		kind: slot => chunkOf(slot).kind[slot & CHUNK_MASK] ?? ENTRY_KIND.other,
		skip: slot => chunkOf(slot).skip[slot & CHUNK_MASK] ?? 0,
		flags: slot => chunkOf(slot).flags[slot & CHUNK_MASK] ?? 0,
		size: slot => chunkOf(slot).size[slot & CHUNK_MASK] ?? -1,
		modified: slot => chunkOf(slot).modified[slot & CHUNK_MASK] ?? NaN,
		parent: slot => chunkOf(slot).parent[slot & CHUNK_MASK] ?? 0,
		name: slot => names[slot] ?? "",
		link: slot => links.get(slot),
		storedPath: slot => storedPaths.get(slot),
		solidSkipped: slot => chunkOf(slot).solidSkipped?.[slot & CHUNK_MASK] ?? 0,
		solidEstimated: slot => chunkOf(slot).solidEstimated?.[slot & CHUNK_MASK] ?? 0,
		dirParent: id => dirParents[id] ?? -1,
		dirName: id => dirNames[id] ?? "",
		dirEntrySlot: id => dirEntrySlots[id] ?? -1,
		dirFlags: id => {
			const slot = dirEntrySlots[id] ?? -1

			return slot < 0 ? (impliedDirFlags[id] ?? 0) : (chunkOf(slot).flags[slot & CHUNK_MASK] ?? 0)
		},
		dirSkip: id => {
			const slot = dirEntrySlots[id] ?? -1

			return slot < 0 ? 0 : (chunkOf(slot).skip[slot & CHUNK_MASK] ?? 0)
		},
		dirModified: id => {
			const slot = dirEntrySlots[id] ?? -1

			return slot < 0 ? NaN : (chunkOf(slot).modified[slot & CHUNK_MASK] ?? NaN)
		},
		childDirs: id => childDirLists[id] ?? NO_CHILDREN,
		childEntries: id => childEntryLists[id] ?? NO_CHILDREN,
		aggFiles: id => aggFileCounts[id] ?? 0,
		aggBytes: id => aggByteCounts[id] ?? 0,
		aggEntries: id => aggEntryCounts[id] ?? 0,
		findDir: path => pathToDir.get(dirKey(path)) ?? -1,
		dirPath,
		slotOfIndex
	}
}
