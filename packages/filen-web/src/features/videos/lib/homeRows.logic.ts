import { compareIds, compareNames } from "@filen/shared"
import {
	selectSeriesPrimaryAction,
	type ContinueWatchingCard,
	type HomeEntry,
	type HomeIndex,
	type LatestEpisodeCard
} from "@filen/shared/videos"
import type { VideoHomeItem, VideoTitleView } from "@/workers/videoIndex/view.logic"
import {
	cardBadge,
	entryProgress,
	entryTitleId,
	titleWatchOf,
	type CardBadge,
	type TitleWatch
} from "@/features/videos/lib/titleWatch.logic"

// The Videos home: which rows exist, in which order, and the cards in each, from the library's titles, its videos
// and the watch state. Plain and DOM-free; the SDK worker builds them and only the rows cross to the page.

export const HOME_ROW_MAX_CARDS = 40
export const HOME_ROOT_ROW_CARDS = 20

export type CardShape = "poster" | "landscape"

export type CardSubline =
	| { kind: "year"; year: number }
	| { kind: "episode"; season: number; episode: number; episodeEnd: number; title: string }
	| { kind: "remaining"; seconds: number }
	| { kind: "upNext" }
	| { kind: "season"; season: number; count: number }
	| { kind: "newEpisodes"; count: number }
	| { kind: "unsupported"; container: string }

export interface VideoCardModel {
	// Unique within its row.
	key: string
	title: VideoTitleView
	// The video an episode or Continue Watching card stands for; null for a title card.
	item: VideoHomeItem | null
	shape: CardShape
	// The art slot: a poster, or a still (an episode's own one when `item` is an episode).
	slot: "p" | "s"
	sublines: CardSubline[]
	// The video Play starts (stable uuid); null when nothing in the title can be played.
	play: string | null
	// Resume position of `play` in seconds, 0 to start from the beginning.
	resumeSec: number
	progress: number | null
	badge: CardBadge
	unsupported: boolean
	// A resume card can be removed from Continue Watching.
	hideable: boolean
}

export type HomeRowKind = "continue" | "latestMovies" | "latestEpisodes" | "movies" | "shows" | "root" | "other"

export interface HomeRowModel {
	id: string
	kind: HomeRowKind
	// The library directory of a root row.
	rootUuid: string | null
	shape: CardShape
	cards: VideoCardModel[]
}

export type SeeAllTarget = "/videos/movies" | "/videos/shows" | "/videos/other" | "/videos/library/$uuid"

// The library view a row's "See all" opens: the kind or directory it draws from; Continue Watching has none.
export function seeAllTarget(row: Pick<HomeRowModel, "kind">): SeeAllTarget | null {
	switch (row.kind) {
		case "latestMovies":
		case "movies":
			return "/videos/movies"
		case "latestEpisodes":
		case "shows":
			return "/videos/shows"
		case "other":
			return "/videos/other"
		case "root":
			return "/videos/library/$uuid"
		case "continue":
			return null
	}
}

// The watch state a title's card reads: an index of that title's own videos (every title-level derivation reads only
// them), its entries by stable uuid and its watch summary.
export interface TitleWatchData {
	index: HomeIndex
	entries: ReadonlyMap<string, HomeEntry>
	watch: ReadonlyMap<string, TitleWatch>
}

// A title's own card: its poster or still, year, badge and what Play starts.
export function titleCard({
	data,
	title,
	shape,
	key
}: {
	data: TitleWatchData
	title: VideoTitleView
	shape: CardShape
	key?: string
}): VideoCardModel {
	const watch = titleWatchOf(data.watch, title.id)
	const play = titlePlay(data, title)
	const sublines: CardSubline[] = title.unsupported
		? [{ kind: "unsupported", container: title.container }]
		: title.year > 0
			? [{ kind: "year", year: title.year }]
			: []

	return {
		key: key ?? title.id,
		title,
		item: null,
		shape,
		slot: shape === "poster" ? "p" : "s",
		sublines,
		play: play?.stableUuid ?? null,
		resumeSec: play?.resumeSec ?? 0,
		progress: watch.progress,
		badge: title.unsupported ? null : cardBadge(title.kind, watch),
		unsupported: title.unsupported,
		hideable: false
	}
}

// What a title's Play starts: a series' next or in-progress episode, else its primary video, resumed when it has a
// resume point.
export function titlePlay(
	{ index, entries }: Pick<TitleWatchData, "index" | "entries">,
	title: VideoTitleView
): { stableUuid: string; resumeSec: number } | null {
	if (title.unsupported) {
		return null
	}

	if (title.kind === "series") {
		const action = selectSeriesPrimaryAction({ index, seriesId: title.id })

		if (action !== null) {
			return {
				stableUuid: action.entry.video.id,
				resumeSec: action.type === "resume" ? action.entry.state.positionSec : 0
			}
		}
	}

	if (title.primary === null) {
		return null
	}

	const entry = entries.get(title.primary.stableUuid)

	return {
		stableUuid: title.primary.stableUuid,
		resumeSec: entry?.state.inProgress === true ? entry.state.positionSec : 0
	}
}

function episodeSubline(item: VideoHomeItem): CardSubline {
	return { kind: "episode", season: item.season, episode: item.episode, episodeEnd: item.episodeEnd, title: item.episodeTitle }
}

// A card for one video: an episode's still, or a movie's or other video's still with its resume point.
export function entryCard({
	data,
	entry,
	item,
	title,
	type
}: {
	data: Pick<TitleWatchData, "watch">
	entry: HomeEntry
	item: VideoHomeItem
	title: VideoTitleView
	type: "resume" | "next" | "latest"
}): VideoCardModel {
	const resume = type === "resume" ? entryProgress(entry) : { progress: null, remainingSec: null }
	const sublines: CardSubline[] = []

	if (item.itemClass === "episode") {
		sublines.push(episodeSubline(item))
	}

	if (resume.remainingSec !== null) {
		sublines.push({ kind: "remaining", seconds: resume.remainingSec })
	} else if (type === "next") {
		sublines.push({ kind: "upNext" })
	} else if (item.itemClass !== "episode" && title.year > 0) {
		sublines.push({ kind: "year", year: title.year })
	}

	return {
		key: `${type}:${item.stableUuid}`,
		title,
		item,
		shape: "landscape",
		slot: "s",
		sublines,
		play: item.unsupported ? null : item.stableUuid,
		resumeSec: type === "resume" ? entry.state.positionSec : 0,
		progress: resume.progress,
		badge:
			item.itemClass === "episode"
				? entry.state.played
					? { kind: "watched" }
					: null
				: cardBadge(title.kind, titleWatchOf(data.watch, title.id)),
		unsupported: item.unsupported,
		hideable: type === "resume"
	}
}

// One video's card outside the rows (a search result): its resume point when it has one.
export function itemCard({
	data,
	item,
	title
}: {
	data: Pick<TitleWatchData, "entries" | "watch">
	item: VideoHomeItem
	title: VideoTitleView
}): VideoCardModel {
	const entry = data.entries.get(item.stableUuid)

	if (entry === undefined) {
		return {
			key: item.stableUuid,
			title,
			item,
			shape: "landscape",
			slot: "s",
			sublines: item.itemClass === "episode" ? [episodeSubline(item)] : [],
			play: item.unsupported ? null : item.stableUuid,
			resumeSec: 0,
			progress: null,
			badge: null,
			unsupported: item.unsupported,
			hideable: false
		}
	}

	return entryCard({ data, entry, item, title, type: entry.state.resumable ? "resume" : "latest" })
}

// What the home rows are drawn from. Every selection is the one a single index over the whole library would make;
// a card's watch state comes from its own title's videos.
export interface HomeRowsSource {
	// Enabled library directories, in their configured order.
	roots: readonly string[]
	// Continue Watching merged with Next Up, newest play first.
	continueWatching: readonly ContinueWatchingCard[]
	// Movies newest first, one per title.
	latestMovies: readonly VideoTitleView[]
	latestEpisodes: readonly LatestEpisodeCard[]
	// The first `limit` titles of a kind in name order (byTitleName).
	topByName: (kind: "movie" | "series", limit: number) => VideoTitleView[]
	// The first `limit` titles of a directory, or of other videos, newest first (newestFirst).
	topNewest: (filter: { root: string } | { kind: "other" }, limit: number) => VideoTitleView[]
	title: (id: string) => VideoTitleView | undefined
	item: (stableUuid: string) => VideoHomeItem | undefined
	watchData: (titleId: string) => TitleWatchData
}

function continueWatchingCards(source: HomeRowsSource): VideoCardModel[] {
	const out: VideoCardModel[] = []

	for (const card of source.continueWatching) {
		const item = source.item(card.entry.video.id)
		const title = source.title(entryTitleId(card.entry))

		if (item !== undefined && title !== undefined) {
			out.push(entryCard({ data: source.watchData(title.id), entry: card.entry, item, title, type: card.type }))
		}
	}

	return out
}

function latestEpisodeCards(source: HomeRowsSource): VideoCardModel[] {
	const out: VideoCardModel[] = []

	for (const card of source.latestEpisodes) {
		const title = source.title(card.seriesId)

		if (title === undefined) {
			continue
		}

		const data = source.watchData(title.id)

		if (card.type === "episode") {
			const item = source.item(card.entry.video.id)
			const entry = data.entries.get(card.entry.video.id)

			if (item !== undefined && entry !== undefined) {
				out.push(entryCard({ data, entry, item, title, type: "latest" }))
			}

			continue
		}

		const base = titleCard({ data, title, shape: "landscape", key: `${card.type}:${title.id}` })

		out.push({
			...base,
			sublines: [
				card.type === "season" && card.season !== null
					? { kind: "season", season: card.season, count: card.count }
					: { kind: "newEpisodes", count: card.count }
			]
		})
	}

	return out
}

// The library's name order, shared by the grid, the home rows and post-play: the drive's natural, case-insensitive
// name order, then year (a remake after the original), then id.
export function byTitleName(a: VideoTitleView, b: VideoTitleView): number {
	return compareNames(a.sortName, b.sortName) || a.year - b.year || compareIds(a.id, b.id)
}

export function newestFirst(a: VideoTitleView, b: VideoTitleView): number {
	return b.dateAdded - a.dateAdded || byTitleName(a, b)
}

// The nominal aspect of a title's card art: posters for movies and series, stills for other videos.
function nominalAspect(title: VideoTitleView): number {
	return title.kind === "other" ? 16 / 9 : 2 / 3
}

// The row's card shape: the median of its items' aspect ratios, snapped (16:9 from 1.33 up, else 2:3).
export function rowShape(titles: readonly VideoTitleView[]): CardShape {
	if (titles.length === 0) {
		return "poster"
	}

	const aspects = titles.map(nominalAspect).sort((a, b) => a - b)
	const middle = aspects.length >> 1
	const median = aspects.length % 2 === 1 ? (aspects[middle] ?? 0) : ((aspects[middle - 1] ?? 0) + (aspects[middle] ?? 0)) / 2

	return median >= 1.33 ? "landscape" : "poster"
}

function titleRow({
	source,
	id,
	kind,
	rootUuid,
	titles
}: {
	source: HomeRowsSource
	id: string
	kind: HomeRowKind
	rootUuid: string | null
	titles: readonly VideoTitleView[]
}): HomeRowModel {
	const shape = rowShape(titles)

	return {
		id,
		kind,
		rootUuid,
		shape,
		cards: titles.map(title => titleCard({ data: source.watchData(title.id), title, shape }))
	}
}

// Every home row in order; rows with no cards are left out.
export function buildHomeRows(source: HomeRowsSource): HomeRowModel[] {
	const rows: HomeRowModel[] = [
		{ id: "continue", kind: "continue", rootUuid: null, shape: "landscape", cards: continueWatchingCards(source) },
		{
			id: "latestMovies",
			kind: "latestMovies",
			rootUuid: null,
			shape: "poster",
			cards: source.latestMovies.map(title => titleCard({ data: source.watchData(title.id), title, shape: "poster" }))
		},
		{
			id: "latestEpisodes",
			kind: "latestEpisodes",
			rootUuid: null,
			shape: "landscape",
			cards: latestEpisodeCards(source)
		},
		titleRow({ source, id: "movies", kind: "movies", rootUuid: null, titles: source.topByName("movie", HOME_ROW_MAX_CARDS) }),
		titleRow({ source, id: "shows", kind: "shows", rootUuid: null, titles: source.topByName("series", HOME_ROW_MAX_CARDS) }),
		...source.roots.map(uuid =>
			titleRow({
				source,
				id: `root:${uuid}`,
				kind: "root",
				rootUuid: uuid,
				titles: source.topNewest({ root: uuid }, HOME_ROOT_ROW_CARDS)
			})
		),
		titleRow({ source, id: "other", kind: "other", rootUuid: null, titles: source.topNewest({ kind: "other" }, HOME_ROW_MAX_CARDS) })
	]

	return rows.filter(row => row.cards.length > 0)
}

// ── Hero ─────────────────────────────────────────────────────────────────────

export interface HeroModel {
	title: VideoTitleView
	// The Continue Watching card it came from, for its resume point.
	card: VideoCardModel | null
}

// Titles the hero may show when nothing is in Continue Watching: a backdrop of their own and playable here, by id.
export function heroCandidates(titles: readonly VideoTitleView[]): VideoTitleView[] {
	return titles.filter(title => title.backdrop !== null && !title.unsupported).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// One per session: the previous pick while it is still eligible (its Continue Watching card refreshed), else the top
// Continue Watching card's title, else one of `candidates` (heroCandidates) picked by `seed` (0-1).
export function pickHero({
	rows,
	candidates,
	previousId,
	seed
}: {
	rows: readonly HomeRowModel[]
	candidates: readonly VideoTitleView[]
	previousId: string | null
	seed: number
}): HeroModel | null {
	const continueCards = rows.find(row => row.kind === "continue")?.cards ?? []

	if (previousId !== null) {
		const card = continueCards.find(candidate => candidate.title.id === previousId)

		if (card !== undefined) {
			return { title: card.title, card }
		}

		const kept = candidates.find(title => title.id === previousId)

		if (kept !== undefined) {
			return { title: kept, card: null }
		}
	}

	const top = continueCards[0]

	if (top !== undefined) {
		return { title: top.title, card: top }
	}

	const picked = candidates[Math.min(candidates.length - 1, Math.floor(seed * candidates.length))]

	return picked === undefined ? null : { title: picked, card: null }
}

// ── Peek ─────────────────────────────────────────────────────────────────────

// Below this row width a row is laid out for a phone, below the next for a tablet.
export const PEEK_PHONE_MAX = 640
export const PEEK_TABLET_MAX = 960
export const CARD_GAP = 12

// Cards in view per row: never a whole number, so the last card is always cut and the row reads as scrollable.
export function cardsInView(rowWidth: number, shape: CardShape): number {
	const tier = rowWidth < PEEK_PHONE_MAX ? 0 : rowWidth < PEEK_TABLET_MAX ? 1 : 2

	return shape === "poster" ? ([2.3, 4.3, 6.3][tier] ?? 6.3) : ([1.3, 3.3, 4.3][tier] ?? 4.3)
}

// Room above and below a row's cards for the focus/hover lift (scale 1.05) and its ring.
export function rowLiftPadding(artHeight: number): number {
	return Math.ceil(artHeight * 0.025) + 4
}

// A card's width so `cardsInView` cards and the gaps between the whole ones fill the row.
export function peekCardWidth({ rowWidth, shape, gap = CARD_GAP }: { rowWidth: number; shape: CardShape; gap?: number }): number {
	const count = cardsInView(rowWidth, shape)

	return Math.max(0, (rowWidth - gap * Math.floor(count)) / count)
}
