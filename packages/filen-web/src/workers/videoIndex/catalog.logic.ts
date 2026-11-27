import {
	buildContinueWatchingRow,
	buildHomeIndex,
	deriveWatchState,
	itemKey,
	selectContinueWatching,
	selectLatestEpisodes,
	selectLatestMovies,
	selectNextUp,
	type ContinueWatchingCard,
	type HomeEntry,
	type HomeSeries,
	type ItemRec,
	type LatestEpisodeCard
} from "@filen/shared/videos"
import {
	titleArtCandidates,
	type LibraryFiles,
	type TitleArtCandidates,
	type VideoHomeItem,
	type VideoTitleView
} from "@/workers/videoIndex/view.logic"
import {
	buildTitleWatch,
	buildVideoHomeIndex,
	homeEntries,
	titleWatchOf,
	toHomeVideos,
	type TitleWatch
} from "@/features/videos/lib/titleWatch.logic"
import {
	HOME_ROOT_ROW_CARDS,
	HOME_ROW_MAX_CARDS,
	buildHomeRows,
	byTitleName,
	heroCandidates,
	itemCard,
	newestFirst,
	pickHero,
	rowShape,
	titleCard,
	type CardShape,
	type HeroModel,
	type HomeRowModel,
	type HomeRowsSource,
	type TitleWatchData,
	type VideoCardModel
} from "@/features/videos/lib/homeRows.logic"
import {
	gridCompare,
	gridCoverage,
	gridFilter,
	gridReadsWatch,
	inGridSource,
	needsProbeFacts,
	type GridPrefs,
	type GridSource,
	type GridView,
	type ProbeFacts
} from "@/features/videos/lib/videoGrid.logic"
import {
	buildVideoSearchIndexSteps,
	filterTitlesByQuery,
	searchVideos,
	titleSearchTokens,
	type SearchGroupKind,
	type VideoSearchIndex
} from "@/features/videos/lib/search.logic"
import { videoKindCounts, type VideoKindCounts } from "@/features/videos/lib/libraryView.logic"
import { nextMovieInDirectory } from "@/features/videos/lib/player/postPlay.logic"

export function gridKey(query: GridQuery): string {
	return JSON.stringify([query.source, query.prefs, query.query, query.seed])
}

// The library's titles and videos as the SDK worker keeps them for the page: home rows, grid pages and search
// results are built here from the classification (or its persisted copy) and the watch state the page hands over,
// and only what a screen shows crosses to it. Plain and IO-free.

// Selections that read only the titles and videos (no watch state), kept with them and persisted alongside.
export interface CatalogDerived {
	// Shown titles (indices into `titles`) by name (byTitleName) and newest first (newestFirst).
	nameOrder: Uint32Array
	newestOrder: Uint32Array
	// The Latest Movies row's titles.
	latestMovies: Uint32Array
	latestEpisodes: LatestEpisodeRef[]
	// Titles the hero may pick when nothing is in Continue Watching (heroCandidates), by id.
	heroCandidates: Uint32Array
	summary: CatalogSummary
}

// A Latest Episodes card with its series as a title index and an episode card's video as an item index.
export type LatestEpisodeRef =
	| { type: "episode"; series: number; item: number; addedMs: number }
	| { type: "season"; series: number; season: number | null; count: number; addedMs: number }
	| { type: "series"; series: number; count: number; addedMs: number }

// A catalog's titles, each built when first read: a persisted catalog keeps them as columns until a screen needs one.
export interface CatalogTitles {
	readonly length: number
	at: (index: number) => VideoTitleView | undefined
	id: (index: number) => string
}

export function arrayTitles(titles: readonly VideoTitleView[]): CatalogTitles {
	return {
		length: titles.length,
		at: index => titles[index],
		id: index => titles[index]?.id ?? ""
	}
}

// Every title of `titles`, built.
export function allTitles(titles: CatalogTitles): VideoTitleView[] {
	const out: VideoTitleView[] = []

	for (let index = 0; index < titles.length; index++) {
		const title = titles.at(index)

		if (title !== undefined) {
			out.push(title)
		}
	}

	return out
}

// A catalog's videos, each built when first read: a persisted catalog keeps them as columns until a screen needs one.
export interface CatalogItems {
	readonly length: number
	at: (index: number) => VideoHomeItem | undefined
	stableUuid: (index: number) => string
	uuid: (index: number) => string
	// The title (index into the catalog's titles) the video belongs to.
	title: (index: number) => number
}

// The art slots a card shows: a poster, or a still.
export const CARD_ART_SLOTS = ["p", "s"] as const

export type CardArtSlot = (typeof CARD_ART_SLOTS)[number]

// Every title's card art candidates, kept with the catalog so a cold open's cards look their art up before the library
// is classified again.
export interface CatalogArt {
	at: (title: number, slot: CardArtSlot) => TitleArtCandidates | null
}

// Card art computed from a classification when read (nothing is kept but the classification itself).
export function libraryArt(files: LibraryFiles, titles: CatalogTitles): CatalogArt {
	return {
		at: (title, slot) => {
			const view = titles.at(title)

			return view === undefined ? null : titleArtCandidates(files, view, slot)
		}
	}
}

const NO_ART: CatalogArt = { at: () => null }

export interface CatalogContent {
	// Every title in classifier order, hidden ones included.
	titles: CatalogTitles
	// Every playable video of the shown titles, grouped by title in title order.
	items: CatalogItems
	derived: CatalogDerived
	art: CatalogArt
}

// CatalogItems over videos already built (grouped by title, groupByTitle).
export function arrayItems(titles: readonly VideoTitleView[], items: readonly VideoHomeItem[]): CatalogItems {
	return drain(groupedItemsSteps(titles, items)).view
}

function itemsView(items: readonly VideoHomeItem[], owners: Uint32Array): CatalogItems {
	return {
		length: items.length,
		at: index => items[index],
		stableUuid: index => items[index]?.stableUuid ?? "",
		uuid: index => items[index]?.uuid ?? "",
		title: index => owners[index] ?? 0
	}
}

export interface CatalogSummary {
	titleCount: number
	total: VideoKindCounts
	byRoot: [string, VideoKindCounts][]
	hiddenCount: number
}

export interface HomeQuery {
	// Enabled library directories, in their configured order.
	roots: readonly string[]
	now: number
	heroPreviousId: string | null
	heroSeed: number
}

export interface HomeResult {
	rows: HomeRowModel[]
	hero: HeroModel | null
}

export interface GridQuery {
	source: GridSource
	prefs: GridPrefs
	query: string
	seed: number
}

export interface GridPage {
	// Titles the query lists, and the source's own count before search and filters.
	total: number
	sourceCount: number
	coverage: GridView["coverage"]
	// Library directories the source's titles were found in, for the directory select.
	rootOptions: string[]
	shape: CardShape
	start: number
	cards: VideoCardModel[]
}

export interface SearchResult {
	groups: { kind: SearchGroupKind; cards: VideoCardModel[]; total: number }[]
}

export interface WatchUpdate {
	reset: boolean
	upserts: Record<string, ItemRec>
	removed: string[]
	lastPlayedCeilingMs: number | undefined
}

// Per probe: runtime (null when unknown) and picture height (0 when unknown).
export interface FactsResult {
	changed: boolean
	affectsWatch: boolean
}

export interface FactsUpdate {
	reset: boolean
	uuids: string[]
	durations: (number | null)[]
	heights: number[]
}

// What changed for the page: titles whose own view changed (their detail follows), and whether anything did.
export interface CatalogChange {
	changed: boolean
	titles: string[]
}

// Title watch summaries computed and kept; past this the oldest go.
const WATCH_DATA_CAP = 1024
// Grid orders kept for paging (sort, filter and search of one screen each).
// Grid orders kept: those of a view without a search, and fewer of searched ones (typing never evicts the base orders).
const GRID_CACHE_CAP = 4
const GRID_SEARCH_CACHE_CAP = 2

const UNWATCHED = titleWatchOf(new Map(), "")

interface GridResult {
	titles: VideoTitleView[]
	sourceCount: number
	coverage: GridView["coverage"]
	rootOptions: string[]
	shape: CardShape
}

// Work between yields of the steps below: comparisons of a sort, titles or videos of a pass.
const SORT_STEP = 4096
const PASS_STEP = 256

// A stable bottom-up merge sort that yields between runs of SORT_STEP comparisons, so a large library's orders never
// hold the worker for long.
function* sortSteps<T>(values: readonly T[], compare: (a: T, b: T) => number): Generator<void, T[]> {
	let from = [...values]
	let to = new Array<T>(from.length)
	let work = 0

	for (let width = 1; width < from.length; width *= 2) {
		for (let start = 0; start < from.length; start += width * 2) {
			const middle = Math.min(start + width, from.length)
			const end = Math.min(start + width * 2, from.length)
			let left = start
			let right = middle
			let out = start

			while (left < middle && right < end) {
				const a = from[left]
				const b = from[right]

				if (a === undefined || b === undefined) {
					break
				}

				if (compare(b, a) < 0) {
					to[out++] = b
					right++
				} else {
					to[out++] = a
					left++
				}

				if (++work % SORT_STEP === 0) {
					yield
				}
			}

			for (; left < middle; left++) {
				const a = from[left]

				if (a !== undefined) {
					to[out++] = a
				}
			}

			for (; right < end; right++) {
				const b = from[right]

				if (b !== undefined) {
					to[out++] = b
				}
			}
		}

		;[from, to] = [to, from]
	}

	return from
}

function* shownOrderSteps(
	titles: readonly VideoTitleView[],
	compare: (a: VideoTitleView, b: VideoTitleView) => number
): Generator<void, Uint32Array> {
	const shown: VideoTitleView[] = []
	const index = new Map<VideoTitleView, number>()

	titles.forEach((title, at) => {
		if (title.hidden !== true) {
			shown.push(title)
			index.set(title, at)
		}
	})

	const sorted = yield* sortSteps(shown, compare)

	return Uint32Array.from(sorted, title => index.get(title) ?? 0)
}

// The watch-independent selections of a catalog: the name and newest orders and the Latest rows (which read when
// videos were added, never whether they were played). Every title's videos are indexed on their own (what an index
// over all of them would hold for it), so the work yields between titles.
export function* deriveCatalogSteps(titles: readonly VideoTitleView[], items: readonly VideoHomeItem[]): Generator<void, CatalogDerived> {
	const titleIndex = new Map(titles.map((title, index) => [title.id, index]))
	const itemIndex = new Map(items.map((item, index) => [item.stableUuid, index]))
	const movieEntries: HomeEntry[] = []
	const series = new Map<string, HomeSeries>()
	let passed = 0

	yield

	for (let start = 0; start < items.length;) {
		const titleId = items[start]?.titleId
		let end = start + 1

		while (end < items.length && items[end]?.titleId === titleId) {
			end++
		}

		const videos = toHomeVideos(items.slice(start, end), () => null)

		if (videos[0]?.itemClass === "movie") {
			movieEntries.push(...buildHomeIndex({ videos: videos.filter(video => video.itemClass === "movie"), items: {} }).entries)
		} else if (videos[0]?.itemClass === "episode") {
			for (const [id, built] of buildHomeIndex({ videos: videos.filter(video => video.itemClass === "episode"), items: {} }).series) {
				series.set(id, built)
			}
		}

		passed += end - start
		start = end

		if (passed >= PASS_STEP * 4) {
			passed = 0

			yield
		}
	}

	const latestMovies: number[] = []

	for (const entry of selectLatestMovies({ index: { entries: movieEntries, series: new Map() }, limit: HOME_ROW_MAX_CARDS })) {
		const index = titleIndex.get(entry.group)

		if (index !== undefined) {
			latestMovies.push(index)
		}
	}

	const latestEpisodes: LatestEpisodeRef[] = []

	for (const card of selectLatestEpisodes({ index: { entries: [], series }, limit: HOME_ROW_MAX_CARDS })) {
		const seriesIndex = titleIndex.get(card.seriesId)

		if (seriesIndex === undefined) {
			continue
		}

		if (card.type === "episode") {
			const item = itemIndex.get(card.entry.video.id)

			if (item !== undefined) {
				latestEpisodes.push({ type: "episode", series: seriesIndex, item, addedMs: card.addedMs })
			}
		} else if (card.type === "season") {
			latestEpisodes.push({ type: "season", series: seriesIndex, season: card.season, count: card.count, addedMs: card.addedMs })
		} else {
			latestEpisodes.push({ type: "series", series: seriesIndex, count: card.count, addedMs: card.addedMs })
		}
	}

	const shown = titles.filter(title => title.hidden !== true)
	const counts = videoKindCounts(shown)

	return {
		nameOrder: yield* shownOrderSteps(titles, byTitleName),
		newestOrder: yield* shownOrderSteps(titles, newestFirst),
		latestMovies: Uint32Array.from(latestMovies),
		latestEpisodes,
		heroCandidates: Uint32Array.from(heroCandidates(shown), title => titleIndex.get(title.id) ?? 0),
		summary: {
			titleCount: shown.length,
			total: counts.total,
			byRoot: [...counts.byRoot],
			hiddenCount: titles.length - shown.length
		}
	}
}

function drain<T>(steps: Generator<void, T>): T {
	for (;;) {
		const step = steps.next()

		if (step.done === true) {
			return step.value
		}
	}
}

// The catalog content for a classification's titles and videos: videos grouped by title (in title order, their
// own order kept within each), the derived selections computed.
export function catalogContent(titles: readonly VideoTitleView[], items: readonly VideoHomeItem[]): CatalogContent {
	const grouped = groupByTitle(titles, items)

	return {
		titles: arrayTitles(titles),
		items: arrayItems(titles, grouped),
		derived: drain(deriveCatalogSteps(titles, grouped)),
		art: NO_ART
	}
}

// Every video of `items`, built.
export function allItems(items: CatalogItems): VideoHomeItem[] {
	const out: VideoHomeItem[] = []

	for (let index = 0; index < items.length; index++) {
		const item = items.at(index)

		if (item !== undefined) {
			out.push(item)
		}
	}

	return out
}

export function groupByTitle(titles: readonly VideoTitleView[], items: readonly VideoHomeItem[]): VideoHomeItem[] {
	return drain(groupedItemsSteps(titles, items)).items
}

// A classification's videos grouped by title (in title order, their own order kept within each; a video of no title
// left out) and the view over them, in slices.
export function* groupedItemsSteps(
	titles: readonly VideoTitleView[],
	items: readonly VideoHomeItem[]
): Generator<void, { items: VideoHomeItem[]; view: CatalogItems }> {
	const step = PASS_STEP * 16
	const titleIndex = new Map<string, number>()

	for (let index = 0; index < titles.length; index++) {
		titleIndex.set(titles[index]?.id ?? "", index)

		if (index % step === step - 1) {
			yield
		}
	}

	// Each video's title, and whether they come in title order already (the usual case).
	const owners = new Int32Array(items.length)
	let ordered = true
	let previous = -1

	for (let at = 0; at < items.length; at++) {
		const index = titleIndex.get(items[at]?.titleId ?? "") ?? -1

		owners[at] = index

		if (index !== -1) {
			ordered &&= index >= previous
			previous = index
		}

		if (at % step === step - 1) {
			yield
		}
	}

	const grouped: VideoHomeItem[] = []
	const groupedOwners = new Uint32Array(items.length)

	if (ordered) {
		for (let at = 0; at < items.length; at++) {
			const item = items[at]
			const index = owners[at] ?? -1

			if (item !== undefined && index !== -1) {
				groupedOwners[grouped.length] = index
				grouped.push(item)
			}

			if (at % step === step - 1) {
				yield
			}
		}
	} else {
		// Counting sort by title: each title's videos keep their order.
		const starts = new Uint32Array(titles.length + 1)

		for (let at = 0; at < items.length; at++) {
			const index = owners[at] ?? -1

			if (index !== -1) {
				starts[index + 1] = (starts[index + 1] ?? 0) + 1
			}
		}

		for (let index = 0; index < titles.length; index++) {
			starts[index + 1] = (starts[index + 1] ?? 0) + (starts[index] ?? 0)
		}

		yield

		const placed = new Array<VideoHomeItem | undefined>(starts[titles.length] ?? 0)

		for (let at = 0; at < items.length; at++) {
			const index = owners[at] ?? -1

			if (index !== -1) {
				const to = starts[index] ?? 0

				placed[to] = items[at]
				groupedOwners[to] = index
				starts[index] = to + 1
			}

			if (at % step === step - 1) {
				yield
			}
		}

		for (const item of placed) {
			if (item !== undefined) {
				grouped.push(item)
			}
		}
	}

	return { items: grouped, view: itemsView(grouped, groupedOwners.subarray(0, grouped.length)) }
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true
	}

	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((value, index) => value === b[index])
	}

	if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
		return sameRecord(a as Record<string, unknown>, b as Record<string, unknown>, false)
	}

	return false
}

// Field by field, one level of nested records (file refs) and arrays of primitives (roots).
function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>, nested = true): boolean {
	const keysA = Object.keys(a)

	if (keysA.length !== Object.keys(b).length) {
		return false
	}

	for (const key of keysA) {
		const valueA = a[key]
		const valueB = b[key]

		if (valueA === valueB) {
			continue
		}

		if (!nested || !sameValue(valueA, valueB)) {
			return false
		}
	}

	return true
}

function sameArt(a: TitleArtCandidates | null, b: TitleArtCandidates | null): boolean {
	if (a === null || b === null) {
		return a === b
	}

	return (
		a.candidates.length === b.candidates.length &&
		a.files.length === b.files.length &&
		a.candidates.every((candidate, index) => {
			const other = b.candidates[index]

			return other !== undefined && sameRecord(candidate, other, false)
		}) &&
		a.files.every((file, index) => {
			const other = b.files[index]

			return (
				other !== undefined &&
				sameRecord(file as unknown as Record<string, unknown>, other as unknown as Record<string, unknown>, false)
			)
		})
	)
}

export class VideoCatalog {
	private content: CatalogContent = catalogContent([], [])
	// By id; built when first needed.
	private titleIndexMap: Map<string, number> | null = null
	private builtTitles: VideoTitleView[] | null = null
	private shownTitles: VideoTitleView[] | null = null
	// By stable uuid; built when first needed.
	private itemIndexMap: Map<string, number> | null = null
	private builtItems: VideoHomeItem[] | null = null
	// Per title, its videos' range in `items`; per video, its title.
	private itemStart = new Uint32Array(0)
	private itemEnd = new Uint32Array(0)
	private itemTitle = new Uint32Array(0)
	private watchItems: Readonly<Record<string, ItemRec>> = {}
	private ceiling: number | undefined = undefined
	private readonly facts = new Map<string, ProbeFacts>()
	// Derived on demand, dropped when what they read changes.
	private readonly watchData = new Map<number, TitleWatchData>()
	private recorded: Set<number> | null = null
	private continueCache: { now: number; cards: ContinueWatchingCard[] } | null = null
	private readonly grids = new Map<string, { result: GridResult; stamp: string }>()
	private searchIndex: VideoSearchIndex | null = null
	private tokens: Map<string, string[]> | null = null
	private byUuid: Map<string, number[]> | null = null
	// Shown movies in post-play's natural order.
	private naturalMovies: VideoTitleView[] | null = null
	// Bumped with each change of the content, the watch state and the probe facts: what a cached grid order or a slice
	// built across a change is checked against.
	private contentGeneration = 0
	private watchGeneration = 0
	private factsGeneration = 0

	// Every video, built (search, diffs, the persisted copy).
	public allItems(): readonly VideoHomeItem[] {
		this.builtItems ??= allItems(this.content.items)

		return this.builtItems
	}

	// Every title, built (grids, search, diffs, the persisted copy).
	private allTitles(): readonly VideoTitleView[] {
		this.builtTitles ??= allTitles(this.content.titles)

		return this.builtTitles
	}

	private shown(): readonly VideoTitleView[] {
		this.shownTitles ??= this.allTitles().filter(title => title.hidden !== true)

		return this.shownTitles
	}

	// Builds the title index in slices ahead of the calls that read it.
	private *titleIndexSteps(): Generator<void, void> {
		if (this.titleIndexMap !== null) {
			return
		}

		const content = this.content
		const map = new Map<string, number>()

		for (let index = 0; index < content.titles.length; index++) {
			map.set(content.titles.id(index), index)

			if (index % (PASS_STEP * 4) === PASS_STEP * 4 - 1) {
				yield
			}
		}

		// Unless the content changed meanwhile (then the next read builds its own).
		if (this.content === content) {
			this.titleIndexMap = map
		}
	}

	private titleIndex(id: string): number | undefined {
		if (this.titleIndexMap === null) {
			const map = new Map<string, number>()

			for (let index = 0; index < this.content.titles.length; index++) {
				map.set(this.content.titles.id(index), index)
			}

			this.titleIndexMap = map
		}

		return this.titleIndexMap.get(id)
	}

	private itemIndex(stableUuid: string): number | undefined {
		if (this.itemIndexMap === null) {
			const map = new Map<string, number>()

			for (let index = 0; index < this.content.items.length; index++) {
				map.set(this.content.items.stableUuid(index), index)
			}

			this.itemIndexMap = map
		}

		return this.itemIndexMap.get(stableUuid)
	}

	private itemRange(start: number, end: number): VideoHomeItem[] {
		const out: VideoHomeItem[] = []

		for (let index = start; index < end; index++) {
			const item = this.content.items.at(index)

			if (item !== undefined) {
				out.push(item)
			}
		}

		return out
	}

	// What the persisted copy is written from.
	public persisted(): CatalogContent {
		return this.content
	}

	// What a classification's titles and videos (grouped by title, groupByTitle) change against the content held:
	// the titles whose views changed (added and removed ones included), and whether anything did.
	public diff(titles: readonly VideoTitleView[], items: readonly VideoHomeItem[], art: CatalogArt): CatalogChange {
		return drain(this.diffSteps(titles, items, art))
	}

	// diff in steps (yields between them).
	// `art`: the new classification's card art; a title whose art alone changed (a poster added, replaced or removed)
	// counts as changed too. Read only here, so a first classification (nothing to compare with) never builds it.
	public *diffSteps(titles: readonly VideoTitleView[], items: readonly VideoHomeItem[], art: CatalogArt): Generator<void, CatalogChange> {
		const previous = this.content
		const changedTitles: string[] = []
		let changed = previous.items.length !== items.length || previous.titles.length !== titles.length
		const next = new Set<string>()
		let passed = 0

		yield* this.titleIndexSteps()

		for (let position = 0; position < titles.length; position++) {
			const title = titles[position]

			if (++passed % PASS_STEP === 0) {
				yield
			}

			if (title === undefined) {
				continue
			}

			const before = this.titleIndex(title.id)
			const old = before === undefined ? undefined : previous.titles.at(before)

			next.add(title.id)

			// The orders and selections name titles by position: one that moved (a hidden one, one without videos)
			// changes them even when no view did.
			if (before !== position) {
				changed = true
			}

			if (
				old === undefined ||
				before === undefined ||
				!sameRecord(old as unknown as Record<string, unknown>, title as unknown as Record<string, unknown>) ||
				!sameArt(previous.art.at(before, "p"), art.at(position, "p")) ||
				!sameArt(previous.art.at(before, "s"), art.at(position, "s"))
			) {
				changedTitles.push(title.id)
			}
		}

		for (let index = 0; index < previous.titles.length; index++) {
			const id = previous.titles.id(index)

			if (!next.has(id)) {
				changedTitles.push(id)
			}

			if (++passed % PASS_STEP === 0) {
				yield
			}
		}

		for (let index = 0; index < items.length && !changed && changedTitles.length === 0; index++) {
			const old = previous.items.at(index)
			const item = items[index]

			changed =
				old === undefined ||
				item === undefined ||
				!sameRecord(old as unknown as Record<string, unknown>, item as unknown as Record<string, unknown>)

			if (++passed % PASS_STEP === 0) {
				yield
			}
		}

		return {
			changed: changed || changedTitles.length > 0,
			titles: changedTitles
		}
	}

	// Swaps the card art source alone (a classification that changed nothing else), keeping every cache.
	public replaceArt(art: CatalogArt): void {
		this.content = { ...this.content, art }
	}

	public setContent(content: CatalogContent): void {
		this.content = content
		this.titleIndexMap = null
		this.builtTitles = null
		this.shownTitles = null
		this.itemIndexMap = null
		this.builtItems = null
		this.itemStart = new Uint32Array(content.titles.length)
		this.itemEnd = new Uint32Array(content.titles.length)
		this.itemTitle = new Uint32Array(content.items.length)

		for (let index = 0; index < content.items.length; index++) {
			const title = content.items.title(index)

			if (this.itemEnd[title] === 0) {
				this.itemStart[title] = index
			}

			this.itemEnd[title] = index + 1
			this.itemTitle[index] = title
		}

		this.dropDerived()
	}

	private dropDerived(): void {
		this.contentGeneration++
		this.naturalMovies = null
		this.watchData.clear()
		this.recorded = null
		this.continueCache = null
		this.grids.clear()
		this.searchIndex = null
		this.tokens = null
		this.byUuid = null
	}

	// ── Watch state and probe facts (handed over by the page) ──

	public setWatch(update: WatchUpdate): void {
		const all = update.reset || update.lastPlayedCeilingMs !== this.ceiling
		const merged = update.reset ? { ...update.upserts } : { ...this.watchItems, ...update.upserts }
		const removed = new Set(update.removed)

		this.watchItems = removed.size === 0 ? merged : Object.fromEntries(Object.entries(merged).filter(([key]) => !removed.has(key)))
		this.watchGeneration++
		this.ceiling = update.lastPlayedCeilingMs
		this.recorded = null
		this.continueCache = null

		if (all) {
			this.watchData.clear()

			return
		}

		for (const key of [...Object.keys(update.upserts), ...update.removed]) {
			const item = key.startsWith("s:") ? this.itemIndex(key.slice(2)) : undefined

			if (item !== undefined) {
				this.watchData.delete(this.itemTitle[item] ?? -1)
			}
		}
	}

	// Takes probe facts in; says whether any changed, and whether one landed on a title with watch-state records (whose
	// rows then change too). A grid order reading them (runtime sort, resolution filter) is rebuilt when next asked for.
	public *setFactsSteps(update: FactsUpdate): Generator<void, FactsResult> {
		const content = this.content

		yield* this.uuidIndexSteps()

		if (update.reset) {
			this.facts.clear()
		}

		const titles = new Set<number>()
		let changed = update.reset

		for (let index = 0; index < update.uuids.length; index++) {
			const uuid = update.uuids[index] ?? ""
			const durationSec = update.durations[index] ?? null
			const height = update.heights[index] ?? 0
			const held = this.facts.get(uuid)

			if (held?.durationSec !== durationSec || held.height !== height) {
				this.facts.set(uuid, { durationSec, height })
				changed = true

				for (const item of this.content === content ? (this.byUuid?.get(uuid) ?? []) : []) {
					titles.add(this.itemTitle[item] ?? -1)
				}
			}

			if (index % (PASS_STEP * 4) === PASS_STEP * 4 - 1) {
				yield
			}
		}

		if (!changed) {
			return { changed: false, affectsWatch: false }
		}

		this.factsGeneration++

		// A replaced catalog mid-update: its titles were not tracked, so every row is re-evaluated.
		if (update.reset || this.content !== content) {
			this.watchData.clear()
			this.continueCache = null
			this.watchGeneration++

			return { changed: true, affectsWatch: true }
		}

		const recorded = this.recordedTitles()
		let affectsWatch = false

		for (const title of titles) {
			this.watchData.delete(title)
			affectsWatch ||= recorded.has(title)
		}

		// Durations decide what counts as played, so orders reading the watch state are rebuilt too.
		if (affectsWatch) {
			this.continueCache = null
			this.watchGeneration++
		}

		return { changed: true, affectsWatch }
	}

	public setFacts(update: FactsUpdate): FactsResult {
		return drain(this.setFactsSteps(update))
	}

	// Videos by current file uuid (what probe facts name), from the columns in slices.
	private *uuidIndexSteps(): Generator<void, void> {
		if (this.byUuid !== null) {
			return
		}

		const content = this.content
		const map = new Map<string, number[]>()

		for (let index = 0; index < content.items.length; index++) {
			const uuid = content.items.uuid(index)
			const list = map.get(uuid)

			if (list === undefined) {
				map.set(uuid, [index])
			} else {
				list.push(index)
			}

			if (index % (PASS_STEP * 4) === PASS_STEP * 4 - 1) {
				yield
			}
		}

		if (this.content === content) {
			this.byUuid = map
		}
	}

	private readonly durationOf = (uuid: string): number | null => this.facts.get(uuid)?.durationSec ?? null

	// ── Per-title watch state ──

	// A title's watch state from its own videos: every title-level derivation reads only those, so it is what an index
	// over the whole library would say of it.
	private titleData(index: number): TitleWatchData {
		const cached = this.watchData.get(index)

		if (cached !== undefined) {
			this.watchData.delete(index)
			this.watchData.set(index, cached)

			return cached
		}

		const homeIndex = buildVideoHomeIndex({
			items: this.itemRange(this.itemStart[index] ?? 0, this.itemEnd[index] ?? 0),
			watchItems: this.watchItems,
			lastPlayedCeilingMs: this.ceiling,
			durationOf: this.durationOf
		})
		const data: TitleWatchData = {
			index: homeIndex,
			entries: homeEntries(homeIndex),
			watch: buildTitleWatch(homeIndex)
		}

		this.watchData.set(index, data)

		if (this.watchData.size > WATCH_DATA_CAP) {
			const oldest = this.watchData.keys().next()

			if (oldest.done !== true) {
				this.watchData.delete(oldest.value)
			}
		}

		return data
	}

	private dataFor(titleId: string): TitleWatchData {
		return this.titleData(this.titleIndex(titleId) ?? -1)
	}

	// Titles one of whose videos has a watch-state record.
	private recordedTitles(): ReadonlySet<number> {
		if (this.recorded === null) {
			this.recorded = new Set()

			for (const key of Object.keys(this.watchItems)) {
				const item = key.startsWith("s:") ? this.itemIndex(key.slice(2)) : undefined

				if (item !== undefined) {
					this.recorded.add(this.itemTitle[item] ?? -1)
				}
			}
		}

		return this.recorded
	}

	// What filters and sorts read of a title's watch state; a title none of whose videos has a record is unwatched.
	private readonly watchOf = (titleId: string): TitleWatch => {
		const index = this.titleIndex(titleId)

		if (index === undefined || !this.recordedTitles().has(index)) {
			return UNWATCHED
		}

		return titleWatchOf(this.titleData(index).watch, titleId)
	}

	// Continue Watching merged with Next Up: both read only played videos, and a played episode's whole series.
	private continueWatching(now: number): ContinueWatchingCard[] {
		if (this.continueCache?.now === now) {
			return this.continueCache.cards
		}

		const picked = new Set<number>()

		for (const key of Object.keys(this.watchItems)) {
			const item = key.startsWith("s:") ? this.itemIndex(key.slice(2)) : undefined

			if (item === undefined) {
				continue
			}

			if (this.content.items.at(item)?.itemClass === "episode") {
				const title = this.itemTitle[item] ?? 0

				for (let at = this.itemStart[title] ?? 0; at < (this.itemEnd[title] ?? 0); at++) {
					picked.add(at)
				}
			} else {
				picked.add(item)
			}
		}

		const homeIndex = buildVideoHomeIndex({
			items: [...picked].sort((a, b) => a - b).flatMap(item => this.content.items.at(item) ?? []),
			watchItems: this.watchItems,
			lastPlayedCeilingMs: this.ceiling,
			durationOf: this.durationOf
		})
		const cards = buildContinueWatchingRow({
			resume: selectContinueWatching({ index: homeIndex, limit: HOME_ROW_MAX_CARDS }),
			nextUp: selectNextUp({ index: homeIndex, now, limit: HOME_ROW_MAX_CARDS }),
			limit: HOME_ROW_MAX_CARDS
		})

		this.continueCache = { now, cards }

		return cards
	}

	// ── Queries ──

	public summary(): CatalogSummary {
		return this.content.derived.summary
	}

	// A card's art candidates as the catalog keeps them: a title's poster or still, or a non-episode video's still (its
	// title's); null when not kept.
	public cardArt(titleId: string, slot: CardArtSlot, stableUuid: string | null): TitleArtCandidates | null {
		const index = this.titleIndex(titleId)
		const title = index === undefined ? undefined : this.content.titles.at(index)

		if (index === undefined || title === undefined) {
			return null
		}

		if (stableUuid !== null) {
			const item = this.itemIndex(stableUuid)

			// An episode's still is its own; a movie's or other video's is its title's.
			if (title.kind === "series" || slot !== "s" || item === undefined || this.itemTitle[item] !== index) {
				return null
			}
		}

		return this.content.art.at(index, slot)
	}

	public title(id: string): VideoTitleView | null {
		const index = this.titleIndex(id)

		return index === undefined ? null : (this.content.titles.at(index) ?? null)
	}

	public hidden(): VideoTitleView[] {
		return this.allTitles().filter(title => title.hidden === true)
	}

	public series(): { id: string; title: string }[] {
		return this.shown()
			.filter(title => title.kind === "series")
			.map(title => ({ id: title.id, title: title.title }))
	}

	// The videos a card's Mark watched / unwatched applies to: every version of its episode or movie (`group`), or
	// every video of the title.
	public markTargets(titleId: string, group: string | null): string[] {
		const index = this.titleIndex(titleId)

		if (index === undefined) {
			return []
		}

		return this.itemRange(this.itemStart[index] ?? 0, this.itemEnd[index] ?? 0)
			.filter(item => (group === null || item.group === group) && !item.unsupported)
			.map(item => item.stableUuid)
	}

	public nextMovie(titleId: string): { id: string; title: string } | null {
		const movie = nextMovieInDirectory({
			titles: this.naturalMovies ?? this.shown(),
			ordered: this.naturalMovies !== null,
			currentId: titleId,
			played: title =>
				title.primary !== null &&
				deriveWatchState({
					rec: this.watchItems[itemKey(title.primary.stableUuid)],
					file: { uuid: title.primary.uuid, size: title.primary.size }
				}).played
		})

		return movie === null ? null : { id: movie.id, title: movie.title }
	}

	public home(query: HomeQuery): HomeResult {
		const { titles, items, derived } = this.content
		const source: HomeRowsSource = {
			roots: query.roots,
			continueWatching: this.continueWatching(query.now),
			latestMovies: Array.from(derived.latestMovies, index => titles.at(index)).filter(title => title !== undefined),
			latestEpisodes: derived.latestEpisodes.flatMap(ref => this.latestEpisodeCard(ref)),
			topByName: (kind, limit) => this.top(derived.nameOrder, title => title.kind === kind, limit),
			topNewest: (filter, limit) =>
				this.top(
					derived.newestOrder,
					"root" in filter ? title => title.roots.includes(filter.root) : title => title.kind === filter.kind,
					limit
				),
			title: id => this.title(id) ?? undefined,
			item: stableUuid => {
				const index = this.itemIndex(stableUuid)

				return index === undefined ? undefined : items.at(index)
			},
			watchData: id => this.dataFor(id)
		}
		const rows = buildHomeRows(source)
		const candidates = Array.from(derived.heroCandidates, index => titles.at(index)).filter(title => title !== undefined)

		return {
			rows,
			hero: pickHero({ rows, candidates, previousId: query.heroPreviousId, seed: query.heroSeed })
		}
	}

	private latestEpisodeCard(ref: LatestEpisodeRef): LatestEpisodeCard[] {
		const series = this.content.titles.at(ref.series)

		if (series === undefined) {
			return []
		}

		if (ref.type !== "episode") {
			return [{ ...ref, seriesId: series.id }]
		}

		const item = this.content.items.at(ref.item)
		const entry = item === undefined ? undefined : this.titleData(ref.series).entries.get(item.stableUuid)

		return entry === undefined ? [] : [{ type: "episode", seriesId: series.id, entry, addedMs: ref.addedMs }]
	}

	private top(order: Uint32Array, keep: (title: VideoTitleView) => boolean, limit: number): VideoTitleView[] {
		const out: VideoTitleView[] = []

		for (const index of order) {
			const title = this.content.titles.at(index)

			if (title !== undefined && keep(title)) {
				out.push(title)

				if (out.length === limit) {
					break
				}
			}
		}

		return out
	}

	public grid(query: GridQuery, start: number, count: number): GridPage {
		const result = this.gridResult(query)
		const from = Math.max(0, Math.min(start, result.titles.length))

		return {
			total: result.titles.length,
			sourceCount: result.sourceCount,
			coverage: result.coverage,
			rootOptions: result.rootOptions,
			shape: result.shape,
			start: from,
			cards: result.titles
				.slice(from, from + Math.max(0, count))
				.map(title => titleCard({ data: this.dataFor(title.id), title, shape: result.shape }))
		}
	}

	// The ids of a grid order's titles from `start` up to `end` (excluded): what a range or select-all selects.
	public gridIds(query: GridQuery, start: number, end: number): string[] {
		return this.gridResult(query)
			.titles.slice(Math.max(0, start), Math.max(0, end))
			.map(title => title.id)
	}

	// What a grid order was built from: the content, and the watch state or probe facts when its prefs read them.
	private gridStamp(prefs: GridPrefs): string {
		const watch = gridReadsWatch(prefs) ? String(this.watchGeneration) : ""
		const facts = needsProbeFacts(prefs) ? String(this.factsGeneration) : ""

		return `${String(this.contentGeneration)}:${watch}:${facts}`
	}

	// Whether the order of a grid query is held and current.
	public hasGrid(query: GridQuery): boolean {
		return this.grids.get(gridKey(query))?.stamp === this.gridStamp(query.prefs)
	}

	// The order of a grid query: the held one (the worker warms it in slices first, gridWarmSteps), else built here.
	private gridResult(query: GridQuery): GridResult {
		const key = gridKey(query)
		const stamp = this.gridStamp(query.prefs)
		const cached = this.grids.get(key)

		if (cached?.stamp === stamp) {
			this.grids.delete(key)
			this.grids.set(key, cached)

			return cached.result
		}

		return this.keepGrid(query, stamp, drain(this.gridResultSteps(query, () => false)))
	}

	private keepGrid(query: GridQuery, stamp: string, result: GridResult): GridResult {
		const key = gridKey(query)
		const searched = query.query.trim().length > 0

		this.grids.delete(key)
		this.grids.set(key, { result, stamp })

		// The oldest of its kind goes past the cap: base orders and searched ones are counted apart.
		const kind = [...this.grids.keys()].filter(
			other => (JSON.parse(other) as [unknown, unknown, string])[2].trim().length > 0 === searched
		)

		if (kind.length > (searched ? GRID_SEARCH_CACHE_CAP : GRID_CACHE_CAP)) {
			this.grids.delete(kind[0] ?? "")
		}

		return result
	}

	// Titles that pass `keep`, in slices.
	private *filterSteps(titles: readonly VideoTitleView[], keep: (title: VideoTitleView) => boolean): Generator<void, VideoTitleView[]> {
		const out: VideoTitleView[] = []

		for (let index = 0; index < titles.length; index++) {
			const title = titles[index]

			if (title !== undefined && keep(title)) {
				out.push(title)
			}

			if (index % (PASS_STEP * 4) === PASS_STEP * 4 - 1) {
				yield
			}
		}

		return out
	}

	// `cancelled`: a newer query of the same view superseded this one (it returns early, half built).
	private *gridResultSteps(query: GridQuery, cancelled: () => boolean): Generator<void, GridResult> {
		const { source } = query
		const inSource = (title: VideoTitleView): boolean => inGridSource(title, source)
		const { nameOrder } = this.content.derived
		const empty: GridResult = { titles: [], sourceCount: 0, coverage: null, rootOptions: [], shape: "poster" }

		yield* this.builtTitlesSteps()

		const sourceTitles = yield* this.filterSteps(this.shown(), inSource)
		const byName: VideoTitleView[] = []

		for (let at = 0; at < nameOrder.length; at++) {
			const title = this.content.titles.at(nameOrder[at] ?? 0)

			if (title !== undefined && inSource(title)) {
				byName.push(title)
			}

			if (at % (PASS_STEP * 4) === PASS_STEP * 4 - 1) {
				yield

				if (cancelled()) {
					return empty
				}
			}
		}

		let searched = byName

		if (query.query.trim().length > 0) {
			yield* this.tokensSteps()

			const tokens = this.tokens ?? new Map<string, string[]>()

			searched = []

			for (let at = 0; at < byName.length; at += PASS_STEP * 4) {
				searched.push(...filterTitlesByQuery({ titles: byName.slice(at, at + PASS_STEP * 4), query: query.query, tokens }))

				yield

				if (cancelled()) {
					return empty
				}
			}
		}

		const { prefs } = query
		// What filters and sorts read of the watch state, once per title (never per comparison).
		const watched = new Map<string, TitleWatch>()

		if (gridReadsWatch(prefs)) {
			for (let at = 0; at < searched.length; at++) {
				const title = searched[at]

				if (title !== undefined) {
					watched.set(title.id, this.watchOf(title.id))
				}

				if (at % PASS_STEP === PASS_STEP - 1) {
					yield

					if (cancelled()) {
						return empty
					}
				}
			}
		}

		const input = { prefs, watchOf: (id: string) => watched.get(id) ?? UNWATCHED, facts: this.facts, seed: query.seed }
		const filtered = { titles: [] as VideoTitleView[], qualityKnown: 0, qualityTotal: 0 }

		for (let at = 0; at < searched.length; at += PASS_STEP * 4) {
			const part = gridFilter(searched.slice(at, at + PASS_STEP * 4), input)

			filtered.titles.push(...part.titles)
			filtered.qualityKnown += part.qualityKnown
			filtered.qualityTotal += part.qualityTotal

			yield

			if (cancelled()) {
				return empty
			}
		}

		// Already in name order for the title sort; any other is sorted in slices.
		const sorted = prefs.sort === "title" ? filtered.titles : yield* sortSteps(filtered.titles, gridCompare(input))
		// The runtime coverage counts every listed title: a part at a time.
		let coverage = gridCoverage(sorted.slice(0, PASS_STEP * 4), filtered, input)

		for (let at = PASS_STEP * 4; coverage?.kind === "runtime" && at < sorted.length; at += PASS_STEP * 4) {
			yield

			const part = gridCoverage(sorted.slice(at, at + PASS_STEP * 4), filtered, input)

			coverage = { kind: "runtime", known: coverage.known + (part?.known ?? 0), total: coverage.total + (part?.total ?? 0) }
		}

		const rootOptions = new Set<string>()

		for (let at = 0; source.kind !== "root" && at < sourceTitles.length; at++) {
			for (const root of sourceTitles[at]?.roots ?? []) {
				rootOptions.add(root)
			}

			if (at % (PASS_STEP * 16) === PASS_STEP * 16 - 1) {
				yield
			}
		}

		return {
			titles: sorted,
			sourceCount: sourceTitles.length,
			coverage,
			rootOptions: [...rootOptions],
			shape: source.kind === "other" ? "landscape" : source.kind === "root" ? rowShape(sourceTitles) : "poster"
		}
	}

	// The grids' search tokens for every shown title, in slices.
	private *tokensSteps(): Generator<void, void> {
		if (this.tokens !== null) {
			return
		}

		const content = this.content
		const shown = this.shown()
		const tokens = new Map<string, string[]>()

		for (let at = 0; at < shown.length; at += PASS_STEP) {
			for (const [id, list] of titleSearchTokens(shown.slice(at, at + PASS_STEP))) {
				tokens.set(id, list)
			}

			yield
		}

		if (this.content === content) {
			this.tokens = tokens
		}
	}

	// ── Slices ahead of a query ──
	// Each fills, in slices, what one query reads (the title index, built titles and videos, a grid's order, the
	// search index), so the query itself is short. A cache change meanwhile drops what was half built.

	private *builtTitlesSteps(): Generator<void, void> {
		if (this.builtTitles !== null) {
			return
		}

		const content = this.content
		const out: VideoTitleView[] = []

		for (let index = 0; index < content.titles.length; index++) {
			const title = content.titles.at(index)

			if (title !== undefined) {
				out.push(title)
			}

			if (index % PASS_STEP === PASS_STEP - 1) {
				yield
			}
		}

		if (this.content === content) {
			this.builtTitles = out
		}
	}

	private *builtItemsSteps(): Generator<void, void> {
		if (this.builtItems !== null) {
			return
		}

		const content = this.content
		const out: VideoHomeItem[] = []

		for (let index = 0; index < content.items.length; index++) {
			const item = content.items.at(index)

			if (item !== undefined) {
				out.push(item)
			}

			if (index % PASS_STEP === PASS_STEP - 1) {
				yield
			}
		}

		if (this.content === content) {
			this.builtItems = out
		}
	}

	public *homeWarmSteps(query: HomeQuery): Generator<void, void> {
		yield* this.titleIndexSteps()

		const generation = this.contentGeneration
		const { derived } = this.content
		const wanted = new Set<number>([...derived.latestMovies, ...derived.latestEpisodes.map(ref => ref.series)])
		const add = (order: Uint32Array, keep: (title: VideoTitleView) => boolean, limit: number): void => {
			let found = 0

			for (let at = 0; at < order.length && found < limit; at++) {
				const index = order[at] ?? 0
				const title = this.content.titles.at(index)

				if (title !== undefined && keep(title)) {
					wanted.add(index)
					found++
				}
			}
		}

		add(derived.nameOrder, title => title.kind === "movie", HOME_ROW_MAX_CARDS)
		add(derived.nameOrder, title => title.kind === "series", HOME_ROW_MAX_CARDS)
		add(derived.newestOrder, title => title.kind === "other", HOME_ROW_MAX_CARDS)

		for (const root of query.roots) {
			add(derived.newestOrder, title => title.roots.includes(root), HOME_ROOT_ROW_CARDS)
		}

		yield

		let built = 0

		for (const index of wanted) {
			if (generation !== this.contentGeneration) {
				return
			}

			built += (this.itemEnd[index] ?? 0) - (this.itemStart[index] ?? 0) + 1
			this.titleData(index)

			if (built >= PASS_STEP) {
				built = 0

				yield
			}
		}

		if (generation === this.contentGeneration) {
			this.continueWatching(query.now)
		}
	}

	// Builds and keeps a grid query's order; returns early (keeping nothing) when `cancelled` says so or what it read
	// changed meanwhile.
	public *gridWarmSteps(query: GridQuery, cancelled: () => boolean): Generator<void, void> {
		if (this.hasGrid(query)) {
			return
		}

		const stamp = this.gridStamp(query.prefs)
		const result = yield* this.gridResultSteps(query, cancelled)

		if (!cancelled() && stamp === this.gridStamp(query.prefs)) {
			this.keepGrid(query, stamp, result)
		}
	}

	public hasSearchIndex(): boolean {
		return this.searchIndex !== null
	}

	public hasNextMovies(): boolean {
		return this.naturalMovies !== null
	}

	public *searchWarmSteps(): Generator<void, void> {
		if (this.searchIndex !== null) {
			return
		}

		yield* this.builtTitlesSteps()
		yield* this.builtItemsSteps()

		const content = this.content
		const index = yield* buildVideoSearchIndexSteps({ titles: this.shown(), items: this.allItems() })

		if (this.content === content) {
			this.searchIndex = index
		}
	}

	public *nextMovieWarmSteps(): Generator<void, void> {
		if (this.naturalMovies !== null) {
			return
		}

		yield* this.builtTitlesSteps()

		// Post-play walks the name order the catalog already holds: the movies picked out of it, no sort of their own.
		const content = this.content
		const { nameOrder } = content.derived
		const movies: VideoTitleView[] = []

		for (let at = 0; at < nameOrder.length; at++) {
			const title = content.titles.at(nameOrder[at] ?? 0)

			if (title?.kind === "movie") {
				movies.push(title)
			}

			if (at % (PASS_STEP * 4) === PASS_STEP * 4 - 1) {
				yield
			}
		}

		if (this.content === content) {
			this.naturalMovies = movies
		}
	}

	public search(query: string): SearchResult {
		this.searchIndex ??= drain(buildVideoSearchIndexSteps({ titles: this.shown(), items: this.allItems() }))

		return {
			groups: searchVideos({ index: this.searchIndex, query }).map(group => ({
				kind: group.kind,
				total: group.total,
				cards: group.results.map(result =>
					result.item === null
						? titleCard({
								data: this.dataFor(result.title.id),
								title: result.title,
								shape: result.title.kind === "other" ? "landscape" : "poster"
							})
						: itemCard({ data: this.dataFor(result.title.id), item: result.item, title: result.title })
				)
			}))
		}
	}
}
