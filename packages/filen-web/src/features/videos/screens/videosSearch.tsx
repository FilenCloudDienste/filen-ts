import { useDeferredValue, useEffect, useId, useMemo, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { SearchIcon, SearchXIcon } from "lucide-react"
import { useElementSize } from "@/lib/useElementSize"
import { SearchInput } from "@/features/drive/components/searchInput"
import { columnsForWidth } from "@/features/drive/lib/gridLayout"
import { useVideoCardActions } from "@/features/videos/hooks/useVideoCardActions"
import { useCatalogSearchQuery } from "@/features/videos/queries/catalog"
import { videoLibrary } from "@/features/videos/lib/index"
import { useCardFocus } from "@/features/videos/hooks/useCardFocus"
import { CardObserver } from "@/features/videos/lib/cardObserver"
import type { VideoCardModel } from "@/features/videos/lib/homeRows.logic"
import { SEARCH_DEBOUNCE_MS, type SearchGroupKind } from "@/features/videos/lib/search.logic"
import { gridKeyAction } from "@/features/videos/lib/videoGrid.logic"
import { cardCommand, cardCommandAction } from "@/features/videos/lib/cardKeys"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { VideoCard, type VideoCardAction } from "@/features/videos/components/videoCard"
import { EmptyMessage } from "@/components/emptyMessage"

const IS_MAC = isMacPlatform()
const GAP = 16
const POSTER_MIN = 132
const LANDSCAPE_MIN = 220

const GROUP_LABEL_KEYS = {
	movies: "videosMovies",
	shows: "videosShows",
	episodes: "videosSearchEpisodes",
	other: "videosOther"
} as const

interface ResultGroupProps {
	group: { kind: SearchGroupKind; total: number }
	cards: readonly VideoCardModel[]
	width: number
	observer: CardObserver | null
	onAction: (action: VideoCardAction, card: VideoCardModel) => void
}

// One group of results: a labelled grid with its own roving tab stop.
function ResultGroup({ group, cards, width, observer, onAction }: ResultGroupProps) {
	const { t } = useTranslation("videos")
	const headingId = useId()
	const combos = useBindings()
	const [active, setActive] = useState(0)
	const cardFocus = useCardFocus<number>()
	const landscape = group.kind === "episodes" || group.kind === "other"
	const columns = columnsForWidth(width, landscape ? LANDSCAPE_MIN : POSTER_MIN, GAP)
	const activeIndex = Math.min(active, Math.max(0, cards.length - 1))

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		const target = event.target

		if (!(target instanceof HTMLAnchorElement) || !target.hasAttribute("data-video-card") || isRecordingCombo()) {
			return
		}

		const command = cardCommand(event, combos, IS_MAC)

		if (command !== null) {
			event.preventDefault()

			const card = cards[activeIndex]
			const action = card === undefined || event.repeat ? null : cardCommandAction(command, card)

			if (card !== undefined && action !== null) {
				onAction(action, card)
			}

			return
		}

		if (event.altKey || event.ctrlKey || event.metaKey) {
			return
		}

		// Two rows a page: a group shows only its first few results.
		const action = gridKeyAction({ key: event.key, index: activeIndex, count: cards.length, columns, pageRows: 2 })

		if (action.kind === "none" || action.kind === "open") {
			return
		}

		event.preventDefault()

		setActive(action.index)
		cardFocus.focus(action.index, { scroll: true })
	}

	return (
		<section
			aria-labelledby={headingId}
			className="flex flex-col gap-2"
		>
			<div className="flex items-baseline justify-between gap-3">
				<h2
					id={headingId}
					className="text-sm font-medium"
				>
					{t(GROUP_LABEL_KEYS[group.kind])}
				</h2>
				{group.total > cards.length ? (
					<span className="text-xs text-muted-foreground tabular-nums">
						{t("videosSearchShownOf", { shown: cards.length, total: group.total })}
					</span>
				) : null}
			</div>
			<div
				role="list"
				aria-labelledby={headingId}
				className="grid py-2"
				style={{ gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`, gap: GAP }}
				onKeyDown={handleKeyDown}
			>
				{cards.map((card, index) => (
					<VideoCard
						key={card.key}
						card={card}
						nearObserver={observer}
						active={index === activeIndex}
						registerRef={element => {
							cardFocus.register(index, element)
						}}
						onFocusCard={() => {
							setActive(index)
						}}
						onAction={onAction}
					/>
				))}
			</div>
		</section>
	)
}

// Videos search: a debounced query over the library's index in its worker, grouped Movies, Shows, Episodes and
// Other; only the results shown come over. Nothing is listed or probed to answer it; card art loads as the cards
// come near.
export function VideosSearchScreen() {
	const { t } = useTranslation("videos")
	const onAction = useVideoCardActions()
	const [input, setInput] = useState("")
	const [query, setQuery] = useState("")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
	const { width } = useElementSize(scrollElement)

	useEffect(() => {
		toolbar?.querySelector("input")?.focus()
	}, [toolbar])

	// The library's worker builds its search index while the box is still empty, so the first query answers at once.
	useEffect(() => {
		videoLibrary.prepareSearch()
	}, [])

	useEffect(() => {
		const timer = setTimeout(() => {
			setQuery(input)
		}, SEARCH_DEBOUNCE_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [input])

	// Cards within half a screen of the visible part.
	const observer = useMemo(
		() => (scrollElement === null ? null : new CardObserver({ root: scrollElement, rootMargin: "50% 0px", threshold: 0 })),
		[scrollElement]
	)

	useEffect(() => {
		return () => {
			observer?.disconnect()
		}
	}, [observer])

	const trimmed = query.trim()
	// Results render at transition priority (in short slices, never one long task).
	const searchQuery = useCatalogSearchQuery(trimmed)
	const results = useDeferredValue(searchQuery.data)
	const groups = trimmed.length === 0 ? [] : (results?.groups ?? [])
	const total = groups.reduce((sum, group) => sum + group.total, 0)

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<div
				ref={setToolbar}
				className="flex shrink-0 items-center gap-3 px-4 pb-3"
			>
				<SearchInput
					action="videos.search"
					label={t("videosSearchPlaceholder")}
					value={input}
					onChange={setInput}
					onClear={() => {
						setInput("")
					}}
				/>
				<span
					role="status"
					className="ml-auto text-xs text-muted-foreground tabular-nums"
				>
					{trimmed.length > 0 ? t("videosSearchResults", { count: total }) : ""}
				</span>
			</div>
			<div
				ref={setScrollElement}
				className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-6"
			>
				{trimmed.length === 0 ? (
					<EmptyMessage
						icon={SearchIcon}
						title={t("videosSearchEmptyTitle")}
						description={t("videosSearchEmptyBody")}
					/>
				) : results === undefined ? null : groups.length === 0 ? (
					<EmptyMessage
						icon={SearchXIcon}
						title={t("videosSearchNoResultsTitle", { query: trimmed })}
						description={t("videosSearchNoResultsBody")}
					/>
				) : width > 0 ? (
					groups.map(group => (
						<ResultGroup
							key={group.kind}
							group={group}
							cards={group.cards}
							width={width}
							observer={observer}
							onAction={onAction}
						/>
					))
				) : null}
			</div>
		</div>
	)
}
