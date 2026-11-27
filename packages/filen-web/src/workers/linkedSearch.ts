import type { AnyLinkedDir, DirPublicLink, File, LinkedDir, LinkedDirsAndFiles } from "@filen/sdk-rs"
import { nameSearchKey } from "@filen/shared"
import { narrowItem } from "@/features/drive/lib/item"
import { sortByDriveItem, type DriveSortBy } from "@/features/drive/lib/sort"
import { linkedItemName } from "@/features/publicLinks/lib/browse.logic"
import { linkFingerprint } from "@/features/publicLinks/lib/queryKey.logic"

// The search of a public directory link: one recursive listing of the directory searched, held here for the page that
// asked for it, so a query, a sort and the windows after it cost no request and only the window asked for crosses to
// the page. The listing is static (no socket reaches a link), so nothing here watches it. One listing at a time: one
// of another directory or link replaces it, and close() frees it. A directory below the held one searches, lists and
// slides from it as it is. Nothing is persisted.

export type ListLinkedRecursive = (
	dir: AnyLinkedDir,
	link: DirPublicLink,
	onProgress: (downloadedBytes: number, totalBytes: number | undefined) => void
) => Promise<LinkedDirsAndFiles>

// A match, with the directories from the searched one (not included) down to its own: its path, and the crumbs that
// reach it. One array per directory, so the hits of one directory in a window are cloned across once.
export interface LinkedSearchHit {
	item: LinkedDir | File
	trail: readonly LinkedDir[]
}

export interface LinkedSearchRequest {
	// The directory searched: the held one or one below it.
	dirUuid: string
	link: DirPublicLink
	name: string
	sort: DriveSortBy
	start: number
	end: number
}

// `total`: every match; `hits`: the requested window of them in the requested sort.
export interface LinkedSearchRange {
	total: number
	hits: LinkedSearchHit[]
}

// A match as the worker keeps it: `index` is its item's place in the held listing (its directories, then its files).
interface Match extends LinkedSearchHit {
	index: number
}

// A query's matches as last asked for: a longer query narrows them instead of the whole listing, and a window of the
// same query and sort reads them as they are.
interface LastQuery {
	scope: string
	key: string
	sort: DriveSortBy
	matches: Match[]
}

interface Held {
	linkId: string
	rootUuid: string
	listing: LinkedDirsAndFiles
	dirs: ReadonlyMap<string, LinkedDir>
	// Each directory's trail from `trailScope`, null outside it; built as queries reach them.
	trailScope: string
	trails: Map<string, readonly LinkedDir[] | null>
	// Each item's name folded for matching (nameSearchKey), by its index, as queries reach it: folded once per listing.
	folded: (string | undefined)[]
	last: LastQuery | null
}

const NO_TRAIL: readonly LinkedDir[] = []

function linkIdentity(link: DirPublicLink): string {
	return `${link.linkUuid}:${linkFingerprint(link)}`
}

function isDir(item: LinkedDir | File): item is LinkedDir {
	return "inner" in item
}

function parentOf(item: LinkedDir | File): string {
	return isDir(item) ? item.inner.parent : item.parent
}

function trailOf(held: Held, scope: string, uuid: string): readonly LinkedDir[] | null {
	if (uuid === scope) {
		return NO_TRAIL
	}

	if (held.trailScope !== scope) {
		held.trailScope = scope
		held.trails = new Map()
	}

	const known = held.trails.get(uuid)

	if (known !== undefined) {
		return known
	}

	const dir = held.dirs.get(uuid)
	const parent = dir === undefined ? null : trailOf(held, scope, dir.inner.parent)
	const trail = dir === undefined || parent === null ? null : [...parent, dir]

	held.trails.set(uuid, trail)

	return trail
}

// A name folded as nameSearchKey folds a query. The key it is matched against has no whitespace at either end, so the
// trimmed name holds it exactly where the whole name does (matchesNameSearch).
function foldedName(held: Held, index: number, item: LinkedDir | File): string {
	const known = held.folded[index]

	if (known !== undefined) {
		return known
	}

	const folded = nameSearchKey(linkedItemName(item))

	held.folded[index] = folded

	return folded
}

function sortMatches(matches: Match[], sort: DriveSortBy): Match[] {
	const decorated = matches.map(match => ({ match, item: narrowItem(isDir(match.item) ? match.item.inner : match.item) }))

	return sortByDriveItem(decorated, entry => entry.item, sort).map(entry => entry.match)
}

// A listing under way: what it lists, and every caller's progress reporter while it downloads.
interface Pending {
	linkId: string
	rootUuid: string
	promise: Promise<void>
	reporters: Set<Parameters<ListLinkedRecursive>[2]>
}

export function createLinkedSearch(listRecursive: ListLinkedRecursive) {
	let held: Held | null = null
	let pending: Pending | null = null
	// Moves on every open and close, so a listing that lands after a newer one began (or a close) is dropped.
	let generation = 0

	// The held listing when it covers `dirUuid` of `link`.
	function covering(link: DirPublicLink, dirUuid: string): Held | null {
		if (held?.linkId !== linkIdentity(link)) {
			return null
		}

		return held.rootUuid === dirUuid || held.dirs.has(dirUuid) ? held : null
	}

	// Lists `dir` once for its searches and slideshows, unless the held listing already covers it; a second open of the
	// same directory while its listing is under way waits on that one. Resolves once it is held, or once a newer open or
	// a close has superseded it.
	async function open(dir: AnyLinkedDir, link: DirPublicLink, onProgress: Parameters<ListLinkedRecursive>[2]): Promise<void> {
		if (covering(link, dir.inner.uuid) !== null) {
			return
		}

		const linkId = linkIdentity(link)

		if (pending?.linkId === linkId && pending.rootUuid === dir.inner.uuid) {
			const joined = pending

			joined.reporters.add(onProgress)

			try {
				await joined.promise
			} finally {
				joined.reporters.delete(onProgress)
			}

			return
		}

		const ticket = ++generation
		const reporters = new Set([onProgress])

		// The listing it replaces goes now, not once the new one lands.
		held = null

		const listed = listRecursive(dir, link, (downloadedBytes, totalBytes) => {
			for (const report of reporters) {
				report(downloadedBytes, totalBytes)
			}
		})
		const entry: Pending = { linkId, rootUuid: dir.inner.uuid, promise: listed.then(() => undefined), reporters }

		// A failure is this caller's to throw; one who joined gets it from `promise` too.
		entry.promise.catch(() => undefined)

		pending = entry

		let listing: LinkedDirsAndFiles

		try {
			listing = await listed
		} finally {
			if (pending === entry) {
				pending = null
			}
		}

		if (ticket !== generation) {
			return
		}

		held = {
			linkId: linkIdentity(link),
			rootUuid: dir.inner.uuid,
			listing,
			dirs: new Map(listing.dirs.map(entry => [entry.inner.uuid, entry])),
			trailScope: dir.inner.uuid,
			trails: new Map(),
			folded: new Array<string | undefined>(listing.dirs.length + listing.files.length),
			last: null
		}
	}

	function close(): void {
		generation++
		held = null
		pending = null
	}

	// A query's window over the held listing, matched by the drive's name rules (nameSearchKey). A blank query matches
	// nothing. Throws when nothing held covers the directory: the page opens it first.
	function range(request: LinkedSearchRequest): LinkedSearchRange {
		const source = covering(request.link, request.dirUuid)

		if (source === null) {
			throw new Error("no listing is held for this directory's search")
		}

		const key = nameSearchKey(request.name)

		if (key.length === 0) {
			return { total: 0, hits: [] }
		}

		const scope = request.dirUuid
		const last = source.last !== null && source.last.scope === scope ? source.last : null
		let matches: Match[]

		if (last !== null && last.key === key && last.sort === request.sort) {
			matches = last.matches
		} else if (last !== null && key.includes(last.key)) {
			// A narrower query: its matches are among the last one's, already in their order when the sort stays.
			const narrowed = last.matches.filter(match => foldedName(source, match.index, match.item).includes(key))

			matches = last.sort === request.sort ? narrowed : sortMatches(narrowed, request.sort)
		} else {
			const matched: Match[] = []
			const { dirs, files } = source.listing
			const consider = (index: number, item: LinkedDir | File): void => {
				if (!foldedName(source, index, item).includes(key)) {
					return
				}

				const trail = trailOf(source, scope, parentOf(item))

				if (trail !== null) {
					matched.push({ index, item, trail })
				}
			}

			dirs.forEach((dir, index) => {
				consider(index, dir)
			})
			files.forEach((file, index) => {
				consider(dirs.length + index, file)
			})

			matches = sortMatches(matched, request.sort)
		}

		source.last = { scope, key, sort: request.sort, matches }

		return { total: matches.length, hits: matches.slice(request.start, request.end).map(({ item, trail }) => ({ item, trail })) }
	}

	// `dir`'s own listing from the held one, null when it does not cover `dir`.
	function children(dir: AnyLinkedDir, link: DirPublicLink): LinkedDirsAndFiles | null {
		const source = covering(link, dir.inner.uuid)

		if (source === null) {
			return null
		}

		const uuid = dir.inner.uuid

		return {
			dirs: source.listing.dirs.filter(entry => entry.inner.parent === uuid),
			files: source.listing.files.filter(file => file.parent === uuid)
		}
	}

	// Everything below `dir` from the held listing, null when it does not cover `dir`.
	function subtree(dir: AnyLinkedDir, link: DirPublicLink): LinkedDirsAndFiles | null {
		const source = covering(link, dir.inner.uuid)

		if (source === null) {
			return null
		}

		const scope = dir.inner.uuid
		const within = (parent: string): boolean => trailOf(source, scope, parent) !== null

		return {
			dirs: source.listing.dirs.filter(entry => within(entry.inner.parent)),
			files: source.listing.files.filter(file => within(file.parent))
		}
	}

	return { open, close, range, children, subtree }
}
