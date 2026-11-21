import type { TitleArtCandidates, VideoFileRef, VideoHomeItem, VideoTitleView } from "@/workers/videoIndex/view.logic"
import type { ArtCandidate } from "@/features/videos/lib/artwork.logic"
import {
	CARD_ART_SLOTS,
	allItems,
	allTitles,
	type CardArtSlot,
	type CatalogArt,
	type CatalogContent,
	type CatalogItems,
	type CatalogSummary,
	type CatalogTitles,
	type LatestEpisodeRef
} from "@/workers/videoIndex/catalog.logic"

// The persisted catalog: what the library's screens show, written next to the root snapshots (two alternating
// slots, like them) so a cold open paints from it without decoding the snapshots or classifying again. It holds no
// key material. Little-endian; columns of typed arrays over one interned string table, sections 8-byte aligned.
//
// Header (80 B): "FVCT", formatVersion u16, reserved u16, checksum u32 (over everything after byte 16), reserved u32,
// generation u64, key u32 × 2 (what the catalog was classified under: roots, corrections, classifier), titleCount,
// itemCount, refCount, stringCount, stringBytes, rootLinkCount, shownCount, latestEpisodeCount, latestMovieCount,
// heroCandidateCount, summary (a string: its JSON), artCandidateCount, artRefCount (u32 each), reserved to 88. Then f64 columns, u32 columns, u16
// columns, u8 columns, the UTF-8 string blob.
//
// Strings are stored once each; their ends count UTF-16 code units, so the blob decodes in one call and a string is a
// slice of it, cut when first read. Titles and videos are built from their columns only when first read (a cold open
// reads a few hundred of tens of thousands); a video names its title by index.

export const CATALOG_MAGIC = 0x54435646 // "FVCT" read as a little-endian u32
// Bump when the views it stores change shape or meaning (view.logic, catalog.logic's derived selections).
export const CATALOG_FORMAT_VERSION = 2
export const CATALOG_HEADER_BYTES = 88

// Titles, videos, refs or strings written between yields of encodeCatalogSteps.
const ENCODE_STEP = 512
const TITLE_U32 = 12
const TITLE_U16 = 5
const ITEM_U32 = 10
const LATEST_U32 = 4

const KINDS = ["movie", "series", "other"] as const
const ITEM_CLASSES = ["movie", "episode", "other"] as const
const LATEST_TYPES = ["episode", "season", "series"] as const
const ART_SOURCES = ["sidecar", "embedded", "driveThumb", "frame", "typographic", "gradient"] as const
// A synthetic candidate's file.
const ART_NO_FILE = 0xffff

const FLAG_UNSUPPORTED = 4
const FLAG_DISC = 8
const FLAG_HIDDEN = 16
const FLAG_DETAIL_HASH = 32

// FNV-1a over the text from two offsets: a 64-bit key in two halves.
export function catalogKey(text: string): [number, number] {
	let a = 0x811c9dc5
	let b = 0x01000193 ^ 0x5bd1e995

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)

		a = Math.imul(a ^ code, 16_777_619) >>> 0
		b = Math.imul(b ^ code, 16_777_619) >>> 0
		b = (b ^ (b >>> 15)) >>> 0
	}

	return [a, b]
}

// A word-at-a-time hash in two independent lanes: enough to tell a torn or truncated write from an intact one, far
// cheaper than a CRC over the megabytes a large library writes.
function checksum(bytes: Uint8Array): number {
	const words = new Uint32Array(bytes.buffer, bytes.byteOffset + 16, (bytes.length - 16) >>> 2)
	let a = 0x811c9dc5
	let b = 0x01000193
	let i = 0

	for (; i + 1 < words.length; i += 2) {
		a = Math.imul(a ^ (words[i] ?? 0), 16_777_619)
		b = Math.imul(b ^ (words[i + 1] ?? 0), 0x5bd1e995)
	}

	if (i < words.length) {
		a = Math.imul(a ^ (words[i] ?? 0), 16_777_619)
	}

	return (a ^ b) >>> 0
}

function align8(value: number): number {
	return (value + 7) & ~7
}

class StringTable {
	public readonly strings: string[] = []
	private readonly index = new Map<string, number>()

	public add(text: string): number {
		let at = this.index.get(text)

		if (at === undefined) {
			at = this.strings.length
			this.strings.push(text)
			this.index.set(text, at)
		}

		return at
	}
}

class RefTable {
	public readonly refs: VideoFileRef[] = []
	private readonly index = new Map<string, number>()

	// 0 for none, else the ref's position plus one.
	public add(ref: VideoFileRef | null): number {
		if (ref === null) {
			return 0
		}

		const key = `${ref.stableUuid}|${ref.uuid}|${String(ref.size)}|${ref.name}`
		let at = this.index.get(key)

		if (at === undefined) {
			at = this.refs.length
			this.refs.push(ref)
			this.index.set(key, at)
		}

		return at + 1
	}
}

interface Layout {
	refSize: number
	titleDate: number
	itemSize: number
	itemDate: number
	latestAdded: number
	stringEnds: number
	refs: number
	titleU32: number
	rootLinks: number
	itemU32: number
	nameOrder: number
	newestOrder: number
	latestMovies: number
	heroCandidates: number
	artEnds: number
	artRefEnds: number
	artCandidates: number
	artRefs: number
	latestU32: number
	titleU16: number
	titleFlags: number
	itemFlags: number
	latestTypes: number
	blob: number
	end: number
}

function layout(counts: {
	titles: number
	items: number
	refs: number
	strings: number
	stringBytes: number
	rootLinks: number
	shown: number
	latestEpisodes: number
	latestMovies: number
	heroCandidates: number
	artCandidates: number
	artRefs: number
}): Layout {
	let at = CATALOG_HEADER_BYTES
	const take = (bytes: number): number => {
		const start = at

		at = align8(at + bytes)

		return start
	}
	const refSize = take(counts.refs * 8)
	const titleDate = take(counts.titles * 8)
	const itemSize = take(counts.items * 8)
	const itemDate = take(counts.items * 8)
	const latestAdded = take(counts.latestEpisodes * 8)
	const stringEnds = take(counts.strings * 4)
	const refs = take(counts.refs * 12)
	const titleU32 = take(counts.titles * TITLE_U32 * 4)
	const rootLinks = take(counts.rootLinks * 4)
	const itemU32 = take(counts.items * ITEM_U32 * 4)
	const nameOrder = take(counts.shown * 4)
	const newestOrder = take(counts.shown * 4)
	const latestMovies = take(counts.latestMovies * 4)
	const heroCandidates = take(counts.heroCandidates * 4)
	const artEnds = take(counts.titles * 2 * 4)
	const artRefEnds = take(counts.titles * 2 * 4)
	const artCandidates = take(counts.artCandidates * 4)
	const artRefs = take(counts.artRefs * 4)
	const latestU32 = take(counts.latestEpisodes * LATEST_U32 * 4)
	const titleU16 = take(counts.titles * TITLE_U16 * 2)
	const titleFlags = take(counts.titles)
	const itemFlags = take(counts.items)
	const latestTypes = take(counts.latestEpisodes)
	const blob = take(counts.stringBytes)

	return {
		refSize,
		titleDate,
		itemSize,
		itemDate,
		latestAdded,
		stringEnds,
		refs,
		titleU32,
		rootLinks,
		itemU32,
		nameOrder,
		newestOrder,
		latestMovies,
		heroCandidates,
		artEnds,
		artRefEnds,
		artCandidates,
		artRefs,
		latestU32,
		titleU16,
		titleFlags,
		itemFlags,
		latestTypes,
		blob,
		end: at
	}
}

export function encodeCatalog(params: {
	content: CatalogContent
	key: readonly [number, number]
	generation: bigint
}): Uint8Array<ArrayBuffer> {
	const steps = encodeCatalogSteps(params)

	for (;;) {
		const step = steps.next()

		if (step.done === true) {
			return step.value
		}
	}
}

// encodeCatalog in steps (yields between runs of titles, videos and strings).
export function* encodeCatalogSteps({
	content,
	key,
	generation
}: {
	content: CatalogContent
	key: readonly [number, number]
	generation: bigint
}): Generator<void, Uint8Array<ArrayBuffer>> {
	const { derived } = content
	const titles = allTitles(content.titles)
	const items = allItems(content.items)
	const strings = new StringTable()
	const refs = new RefTable()
	const titleU32 = new Uint32Array(titles.length * TITLE_U32)
	const titleU16 = new Uint16Array(titles.length * TITLE_U16)
	const titleFlags = new Uint8Array(titles.length)
	const titleDate = new Float64Array(titles.length)
	const rootLinks: number[] = []

	for (let index = 0; index < titles.length; index++) {
		const title = titles[index]

		if (title === undefined) {
			continue
		}

		const at = index * TITLE_U32

		titleU32[at] = strings.add(title.id)
		titleU32[at + 1] = strings.add(title.title)
		titleU32[at + 2] = strings.add(title.sortName)
		titleU32[at + 3] = strings.add(title.mergeKey)
		titleU32[at + 4] = strings.add(title.container)
		titleU32[at + 5] = refs.add(title.poster)
		titleU32[at + 6] = refs.add(title.backdrop)
		titleU32[at + 7] = refs.add(title.logo)
		titleU32[at + 8] = refs.add(title.primary)

		for (const root of title.roots) {
			rootLinks.push(strings.add(root))
		}

		titleU32[at + 9] = rootLinks.length
		titleU32[at + 10] = title.episodeCount
		titleU32[at + 11] = title.detailHash ?? 0
		titleU16.set([title.year, title.height, title.versionCount, title.extraCount, title.seasonCount], index * TITLE_U16)
		titleFlags[index] =
			KINDS.indexOf(title.kind) |
			(title.unsupported ? FLAG_UNSUPPORTED : 0) |
			(title.disc ? FLAG_DISC : 0) |
			(title.hidden === true ? FLAG_HIDDEN : 0) |
			(title.detailHash === undefined ? 0 : FLAG_DETAIL_HASH)
		titleDate[index] = title.dateAdded

		if (index % ENCODE_STEP === ENCODE_STEP - 1) {
			yield
		}
	}

	// Card art: per title and slot, its candidates (source, then the index into its own refs) and its refs.
	const artEnds = new Uint32Array(titles.length * 2)
	const artRefEnds = new Uint32Array(titles.length * 2)
	const artCandidates: number[] = []
	const artRefs: number[] = []

	for (let index = 0; index < titles.length; index++) {
		CARD_ART_SLOTS.forEach((slot, slotIndex) => {
			const art = content.art.at(index, slot)

			for (const candidate of art?.candidates ?? []) {
				artCandidates.push((ART_SOURCES.indexOf(candidate.source) << 16) | ("file" in candidate ? candidate.file : ART_NO_FILE))
			}

			for (const ref of art?.files ?? []) {
				artRefs.push(refs.add(ref) - 1)
			}

			artEnds[index * 2 + slotIndex] = artCandidates.length
			artRefEnds[index * 2 + slotIndex] = artRefs.length
		})

		// Card art may be computed as it is read (a classification's): a smaller run.
		if (index % (ENCODE_STEP / 8) === ENCODE_STEP / 8 - 1) {
			yield
		}
	}

	const itemU32 = new Uint32Array(items.length * ITEM_U32)
	const itemFlags = new Uint8Array(items.length)
	const itemSize = new Float64Array(items.length)
	const itemDate = new Float64Array(items.length)

	for (let index = 0; index < items.length; index++) {
		const item = items[index]

		if (item === undefined) {
			continue
		}

		itemU32.set(
			[
				content.items.title(index),
				strings.add(item.stableUuid),
				strings.add(item.uuid),
				strings.add(item.episodeTitle),
				strings.add(item.group),
				strings.add(item.label),
				strings.add(item.folder),
				item.season,
				item.episode,
				item.episodeEnd
			],
			index * ITEM_U32
		)
		itemFlags[index] = ITEM_CLASSES.indexOf(item.itemClass) | (item.unsupported ? FLAG_UNSUPPORTED : 0)
		itemSize[index] = item.size
		itemDate[index] = item.dateAdded

		if (index % ENCODE_STEP === ENCODE_STEP - 1) {
			yield
		}
	}

	const refU32 = new Uint32Array(refs.refs.length * 3)
	const refSize = new Float64Array(refs.refs.length)

	for (let index = 0; index < refs.refs.length; index++) {
		const ref = refs.refs[index]

		if (ref === undefined) {
			continue
		}

		refU32.set([strings.add(ref.stableUuid), strings.add(ref.uuid), strings.add(ref.name)], index * 3)
		refSize[index] = ref.size

		if (index % ENCODE_STEP === ENCODE_STEP - 1) {
			yield
		}
	}

	const latest = derived.latestEpisodes
	const latestU32 = new Uint32Array(latest.length * LATEST_U32)
	const latestTypes = new Uint8Array(latest.length)
	const latestAdded = new Float64Array(latest.length)

	latest.forEach((ref, index) => {
		latestU32.set(
			[
				ref.series,
				ref.type === "episode" ? ref.item : 0,
				ref.type === "season" && ref.season !== null ? ref.season + 1 : 0,
				ref.type === "episode" ? 0 : ref.count
			],
			index * LATEST_U32
		)
		latestTypes[index] = LATEST_TYPES.indexOf(ref.type)
		latestAdded[index] = ref.addedMs
	})

	const summary = strings.add(JSON.stringify(derived.summary))
	const stringEnds = new Uint32Array(strings.strings.length)
	let chars = 0

	for (let index = 0; index < strings.strings.length; index++) {
		const text = strings.strings[index]

		if (text === undefined) {
			continue
		}

		chars += text.length
		stringEnds[index] = chars

		if (index % ENCODE_STEP === ENCODE_STEP - 1) {
			yield
		}
	}

	const blob = new TextEncoder().encode(strings.strings.join(""))
	const at = layout({
		titles: titles.length,
		items: items.length,
		refs: refs.refs.length,
		strings: strings.strings.length,
		stringBytes: blob.length,
		rootLinks: rootLinks.length,
		shown: derived.nameOrder.length,
		latestEpisodes: latest.length,
		latestMovies: derived.latestMovies.length,
		heroCandidates: derived.heroCandidates.length,
		artCandidates: artCandidates.length,
		artRefs: artRefs.length
	})
	const out = new Uint8Array(at.end)
	const put = (offset: number, view: ArrayBufferView): void => {
		out.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset)
	}

	put(at.refSize, refSize)
	put(at.titleDate, titleDate)
	put(at.itemSize, itemSize)
	put(at.itemDate, itemDate)
	put(at.latestAdded, latestAdded)
	put(at.stringEnds, stringEnds)
	put(at.refs, refU32)
	put(at.titleU32, titleU32)
	put(at.rootLinks, Uint32Array.from(rootLinks))
	put(at.itemU32, itemU32)
	put(at.nameOrder, derived.nameOrder)
	put(at.newestOrder, derived.newestOrder)
	put(at.latestMovies, derived.latestMovies)
	put(at.heroCandidates, derived.heroCandidates)
	put(at.artEnds, artEnds)
	put(at.artRefEnds, artRefEnds)
	put(at.artCandidates, Uint32Array.from(artCandidates))
	put(at.artRefs, Uint32Array.from(artRefs))
	put(at.latestU32, latestU32)
	put(at.titleU16, titleU16)
	put(at.titleFlags, titleFlags)
	put(at.itemFlags, itemFlags)
	put(at.latestTypes, latestTypes)
	put(at.blob, blob)

	const header = new DataView(out.buffer)

	header.setUint32(0, CATALOG_MAGIC, true)
	header.setUint16(4, CATALOG_FORMAT_VERSION, true)
	header.setBigUint64(16, generation, true)
	header.setUint32(24, key[0], true)
	header.setUint32(28, key[1], true)
	header.setUint32(32, titles.length, true)
	header.setUint32(36, items.length, true)
	header.setUint32(40, refs.refs.length, true)
	header.setUint32(44, strings.strings.length, true)
	header.setUint32(48, blob.length, true)
	header.setUint32(52, rootLinks.length, true)
	header.setUint32(56, derived.nameOrder.length, true)
	header.setUint32(60, latest.length, true)
	header.setUint32(64, derived.latestMovies.length, true)
	header.setUint32(68, derived.heroCandidates.length, true)
	header.setUint32(72, summary, true)
	header.setUint32(76, artCandidates.length, true)
	header.setUint32(80, artRefs.length, true)
	header.setUint32(8, checksum(out), true)

	return out
}

export interface CatalogHeader {
	generation: bigint
	key: [number, number]
}

// The header fields slot selection needs; null when the bytes don't start with a catalog header of this format.
export function readCatalogHeader(bytes: Uint8Array): CatalogHeader | null {
	if (bytes.length < CATALOG_HEADER_BYTES) {
		return null
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, CATALOG_HEADER_BYTES)

	if (view.getUint32(0, true) !== CATALOG_MAGIC || view.getUint16(4, true) !== CATALOG_FORMAT_VERSION) {
		return null
	}

	return {
		generation: view.getBigUint64(16, true),
		key: [view.getUint32(24, true), view.getUint32(28, true)]
	}
}

// The content of an intact catalog written under `key`; null for anything else (another key or format, a size that
// doesn't add up, a checksum mismatch).
export function decodeCatalog(bytes: Uint8Array, key: readonly [number, number]): CatalogContent | null {
	const header = readCatalogHeader(bytes)

	if (header?.key[0] !== key[0] || header.key[1] !== key[1] || bytes.byteOffset % 8 !== 0) {
		return null
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, CATALOG_HEADER_BYTES)
	const titleCount = view.getUint32(32, true)
	const itemCount = view.getUint32(36, true)
	const refCount = view.getUint32(40, true)
	const stringCount = view.getUint32(44, true)
	const at = layout({
		titles: titleCount,
		items: itemCount,
		refs: refCount,
		strings: stringCount,
		stringBytes: view.getUint32(48, true),
		rootLinks: view.getUint32(52, true),
		shown: view.getUint32(56, true),
		latestEpisodes: view.getUint32(60, true),
		latestMovies: view.getUint32(64, true),
		heroCandidates: view.getUint32(68, true),
		artCandidates: view.getUint32(76, true),
		artRefs: view.getUint32(80, true)
	})

	if (at.end !== bytes.length || view.getUint32(8, true) !== checksum(bytes)) {
		return null
	}

	const buffer = bytes.buffer
	const base = bytes.byteOffset
	const f64 = (offset: number, length: number): Float64Array => new Float64Array(buffer, base + offset, length)
	const u32 = (offset: number, length: number): Uint32Array => new Uint32Array(buffer, base + offset, length)
	const blob = new TextDecoder().decode(bytes.subarray(at.blob, at.blob + view.getUint32(48, true)))
	const stringEnds = u32(at.stringEnds, stringCount)
	const strings = new Array<string | undefined>(stringCount)
	const text = (index: number | undefined): string => {
		const at = index ?? 0
		let value = strings[at]

		if (value === undefined) {
			value = blob.slice(at === 0 ? 0 : (stringEnds[at - 1] ?? 0), stringEnds[at] ?? 0)
			strings[at] = value
		}

		return value
	}
	const refColumns = { refU32: u32(at.refs, refCount * 3), refSize: f64(at.refSize, refCount), text }
	const titles = new FileTitles({
		refs: refColumns,
		u32: u32(at.titleU32, titleCount * TITLE_U32),
		u16: new Uint16Array(buffer, base + at.titleU16, titleCount * TITLE_U16),
		flags: bytes.subarray(at.titleFlags, at.titleFlags + titleCount),
		date: f64(at.titleDate, titleCount),
		rootLinks: u32(at.rootLinks, view.getUint32(52, true)),
		text
	})
	const items = new FileItems({
		titles,
		u32: u32(at.itemU32, itemCount * ITEM_U32),
		flags: bytes.subarray(at.itemFlags, at.itemFlags + itemCount),
		size: f64(at.itemSize, itemCount),
		date: f64(at.itemDate, itemCount),
		text
	})

	const latestCount = view.getUint32(60, true)
	const latestU32 = u32(at.latestU32, latestCount * LATEST_U32)
	const latestTypes = bytes.subarray(at.latestTypes, at.latestTypes + latestCount)
	const latestAdded = f64(at.latestAdded, latestCount)
	const latestEpisodes: LatestEpisodeRef[] = []

	for (let i = 0; i < latestCount; i++) {
		const t = i * LATEST_U32
		const series = latestU32[t] ?? 0
		const addedMs = latestAdded[i] ?? 0

		switch (LATEST_TYPES[latestTypes[i] ?? 0]) {
			case "episode":
				latestEpisodes.push({ type: "episode", series, item: latestU32[t + 1] ?? 0, addedMs })
				break
			case "season": {
				const season = latestU32[t + 2] ?? 0

				latestEpisodes.push({
					type: "season",
					series,
					season: season === 0 ? null : season - 1,
					count: latestU32[t + 3] ?? 0,
					addedMs
				})
				break
			}
			default:
				latestEpisodes.push({ type: "series", series, count: latestU32[t + 3] ?? 0, addedMs })
		}
	}

	const shown = view.getUint32(56, true)
	const art = new FileArt({
		refs: refColumns,
		ends: u32(at.artEnds, titleCount * 2),
		refEnds: u32(at.artRefEnds, titleCount * 2),
		candidates: u32(at.artCandidates, view.getUint32(76, true)),
		artRefs: u32(at.artRefs, view.getUint32(80, true))
	})

	return {
		titles,
		items,
		art,
		derived: {
			// Copies, so the file's buffer can go.
			nameOrder: u32(at.nameOrder, shown).slice(),
			newestOrder: u32(at.newestOrder, shown).slice(),
			latestMovies: u32(at.latestMovies, view.getUint32(64, true)).slice(),
			latestEpisodes,
			heroCandidates: u32(at.heroCandidates, view.getUint32(68, true)).slice(),
			summary: JSON.parse(text(view.getUint32(72, true))) as CatalogSummary
		}
	}
}

interface RefColumns {
	refU32: Uint32Array
	refSize: Float64Array
	text: (index: number | undefined) => string
}

function refAt({ refU32, refSize, text }: RefColumns, index: number): VideoFileRef {
	const at = index * 3

	return { stableUuid: text(refU32[at]), uuid: text(refU32[at + 1]), name: text(refU32[at + 2]), size: refSize[index] ?? 0 }
}

// A persisted catalog's card art, built per title and slot when first read.
class FileArt implements CatalogArt {
	private readonly columns: {
		refs: RefColumns
		ends: Uint32Array
		refEnds: Uint32Array
		candidates: Uint32Array
		artRefs: Uint32Array
	}

	public constructor(columns: FileArt["columns"]) {
		this.columns = columns
	}

	public at(title: number, slot: CardArtSlot): TitleArtCandidates | null {
		const { refs, ends, refEnds, candidates, artRefs } = this.columns
		const at = title * 2 + CARD_ART_SLOTS.indexOf(slot)

		if (title < 0 || at >= ends.length) {
			return null
		}

		const start = at === 0 ? 0 : (ends[at - 1] ?? 0)
		const end = ends[at] ?? 0

		// Every kept list ends on a synthetic candidate, so an empty one is a title the classifier had no subject for.
		if (end === start) {
			return null
		}

		const list: ArtCandidate[] = []

		for (let index = start; index < end; index++) {
			const code = candidates[index] ?? 0
			const source = ART_SOURCES[code >>> 16] ?? "gradient"
			const file = code & 0xffff

			list.push(source === "typographic" || source === "gradient" ? { source } : { source, file })
		}

		const files: VideoFileRef[] = []

		for (let index = at === 0 ? 0 : (refEnds[at - 1] ?? 0); index < (refEnds[at] ?? 0); index++) {
			files.push(refAt(refs, artRefs[index] ?? 0))
		}

		return { candidates: list, files }
	}
}

// A persisted catalog's titles, each built from its columns when first read.
class FileTitles implements CatalogTitles {
	public readonly length: number
	private readonly columns: {
		refs: RefColumns
		u32: Uint32Array
		u16: Uint16Array
		flags: Uint8Array
		date: Float64Array
		rootLinks: Uint32Array
		text: (index: number | undefined) => string
	}
	private readonly built: (VideoTitleView | undefined)[]

	public constructor(columns: FileTitles["columns"]) {
		this.columns = columns
		this.length = columns.flags.length
		this.built = new Array<VideoTitleView | undefined>(this.length)
	}

	private ref(value: number | undefined): VideoFileRef | null {
		return value === undefined || value === 0 ? null : refAt(this.columns.refs, value - 1)
	}

	public at(index: number): VideoTitleView | undefined {
		if (index < 0 || index >= this.length) {
			return undefined
		}

		let title = this.built[index]

		if (title === undefined) {
			const { u32, u16, flags, date, rootLinks, text } = this.columns
			const t = index * TITLE_U32
			const s = index * TITLE_U16
			const flag = flags[index] ?? 0
			const roots: string[] = []

			for (let r = index === 0 ? 0 : (u32[t - TITLE_U32 + 9] ?? 0), end = u32[t + 9] ?? 0; r < end; r++) {
				roots.push(text(rootLinks[r]))
			}

			title = {
				id: text(u32[t]),
				kind: KINDS[flag & 3] ?? "other",
				title: text(u32[t + 1]),
				sortName: text(u32[t + 2]),
				year: u16[s] ?? 0,
				mergeKey: text(u32[t + 3]),
				roots,
				dateAdded: date[index] ?? 0,
				poster: this.ref(u32[t + 5]),
				backdrop: this.ref(u32[t + 6]),
				logo: this.ref(u32[t + 7]),
				primary: this.ref(u32[t + 8]),
				container: text(u32[t + 4]),
				height: u16[s + 1] ?? 0,
				unsupported: (flag & FLAG_UNSUPPORTED) !== 0,
				disc: (flag & FLAG_DISC) !== 0,
				versionCount: u16[s + 2] ?? 0,
				extraCount: u16[s + 3] ?? 0,
				seasonCount: u16[s + 4] ?? 0,
				episodeCount: u32[t + 10] ?? 0
			}

			if (flag & FLAG_HIDDEN) {
				title.hidden = true
			}

			if (flag & FLAG_DETAIL_HASH) {
				title.detailHash = u32[t + 11] ?? 0
			}

			this.built[index] = title
		}

		return title
	}

	public id(index: number): string {
		return this.columns.text(this.columns.u32[index * TITLE_U32])
	}
}

// A persisted catalog's videos, each built from its columns when first read.
class FileItems implements CatalogItems {
	public readonly length: number
	private readonly columns: {
		titles: CatalogTitles
		u32: Uint32Array
		flags: Uint8Array
		size: Float64Array
		date: Float64Array
		text: (index: number | undefined) => string
	}
	private readonly built: (VideoHomeItem | undefined)[]

	public constructor(columns: FileItems["columns"]) {
		this.columns = columns
		this.length = columns.flags.length
		this.built = new Array<VideoHomeItem | undefined>(this.length)
	}

	public at(index: number): VideoHomeItem | undefined {
		if (index < 0 || index >= this.length) {
			return undefined
		}

		let item = this.built[index]

		if (item === undefined) {
			const { titles, u32, flags, size, date, text } = this.columns
			const t = index * ITEM_U32
			const flag = flags[index] ?? 0

			item = {
				titleId: titles.id(u32[t] ?? 0),
				stableUuid: text(u32[t + 1]),
				uuid: text(u32[t + 2]),
				size: size[index] ?? 0,
				itemClass: ITEM_CLASSES[flag & 3] ?? "other",
				season: u32[t + 7] ?? 0,
				episode: u32[t + 8] ?? 0,
				episodeEnd: u32[t + 9] ?? 0,
				episodeTitle: text(u32[t + 3]),
				group: text(u32[t + 4]),
				label: text(u32[t + 5]),
				dateAdded: date[index] ?? 0,
				unsupported: (flag & FLAG_UNSUPPORTED) !== 0,
				folder: text(u32[t + 6])
			}
			this.built[index] = item
		}

		return item
	}

	public stableUuid(index: number): string {
		return this.columns.text(this.columns.u32[index * ITEM_U32 + 1])
	}

	public title(index: number): number {
		return this.columns.u32[index * ITEM_U32] ?? 0
	}

	public uuid(index: number): string {
		return this.columns.text(this.columns.u32[index * ITEM_U32 + 2])
	}
}

// The slots worth reading, newest generation first (a missing or unreadable header leaves its slot out).
export function catalogSlotOrder(generations: readonly [bigint | null, bigint | null]): (0 | 1)[] {
	const [a, b] = generations
	const slots: (0 | 1)[] = []

	if (a !== null) {
		slots.push(0)
	}

	if (b !== null) {
		slots.push(1)
	}

	return slots.sort((left, right) => {
		const x = generations[left] ?? -1n
		const y = generations[right] ?? -1n

		return x === y ? 0 : x > y ? -1 : 1
	})
}
