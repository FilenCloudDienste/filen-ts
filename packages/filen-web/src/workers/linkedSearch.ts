import type { AnyLinkedDir, DirPublicLink, File, LinkedDir, LinkedDirsAndFiles } from "@filen/sdk-rs"
import { matchesNameSearch, nameSearchKey } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
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

// A query's matches as last asked for: a longer query narrows them instead of the whole listing, and a window of the
// same query and sort reads them as they are.
interface LastQuery {
	scope: string
	key: string
	sort: DriveSortBy
	hits: LinkedSearchHit[]
}

interface Held {
	linkId: string
	rootUuid: string
	listing: LinkedDirsAndFiles
	dirs: ReadonlyMap<string, LinkedDir>
	// Each directory's trail from `trailScope`, null outside it; built as queries reach them.
	trailScope: string
	trails: Map<string, readonly LinkedDir[] | null>
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

function sortHits(hits: LinkedSearchHit[], sort: DriveSortBy): LinkedSearchHit[] {
	const decorated = hits.map(hit => ({ hit, item: narrowItem(isDir(hit.item) ? hit.item.inner : hit.item) }))

	return sortByDriveItem(decorated, entry => entry.item, sort).map(entry => entry.hit)
}

export function createLinkedSearch(listRecursive: ListLinkedRecursive) {
	let held: Held | null = null
	// Moves on every open and close, so a listing that lands after a newer one began (or a close) is dropped.
	let generation = 0

	// The held listing when it covers `dirUuid` of `link`.
	function covering(link: DirPublicLink, dirUuid: string): Held | null {
		if (held?.linkId !== linkIdentity(link)) {
			return null
		}

		return held.rootUuid === dirUuid || held.dirs.has(dirUuid) ? held : null
	}

	// Lists `dir` once for its searches, unless the held listing already covers it. Resolves once it is held, or once a
	// newer open or a close has superseded it.
	async function open(dir: AnyLinkedDir, link: DirPublicLink, onProgress: Parameters<ListLinkedRecursive>[2]): Promise<void> {
		if (covering(link, dir.inner.uuid) !== null) {
			return
		}

		const ticket = ++generation

		// The listing it replaces goes now, not once the new one lands.
		held = null

		const listing = await listRecursive(dir, link, onProgress)

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
			last: null
		}
	}

	function close(): void {
		generation++
		held = null
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
		let hits: LinkedSearchHit[]

		if (last !== null && last.key === key && last.sort === request.sort) {
			hits = last.hits
		} else if (last !== null && key.includes(last.key)) {
			// A narrower query: its matches are among the last one's, already in their order when the sort stays.
			const narrowed = last.hits.filter(hit => matchesNameSearch(linkedItemName(hit.item), key))

			hits = last.sort === request.sort ? narrowed : sortHits(narrowed, request.sort)
		} else {
			const matched: LinkedSearchHit[] = []

			for (const item of [...source.listing.dirs, ...source.listing.files]) {
				if (!matchesNameSearch(linkedItemName(item), key)) {
					continue
				}

				const trail = trailOf(source, scope, parentOf(item))

				if (trail !== null) {
					matched.push({ item, trail })
				}
			}

			hits = sortHits(matched, request.sort)
		}

		source.last = { scope, key, sort: request.sort, hits }

		return { total: hits.length, hits: hits.slice(request.start, request.end) }
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

	// Everything below `dir` from the held listing (its files only those `keepFile` admits), null when it does not cover
	// `dir`.
	function subtree(dir: AnyLinkedDir, link: DirPublicLink, keepFile: (item: DriveItem) => boolean): LinkedDirsAndFiles | null {
		const source = covering(link, dir.inner.uuid)

		if (source === null) {
			return null
		}

		const scope = dir.inner.uuid
		const within = (parent: string): boolean => trailOf(source, scope, parent) !== null

		return {
			dirs: source.listing.dirs.filter(entry => within(entry.inner.parent)),
			files: source.listing.files.filter(file => within(file.parent) && keepFile(narrowItem(file)))
		}
	}

	return { open, close, range, children, subtree }
}
