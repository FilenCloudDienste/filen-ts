import {
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
	type RefObject
} from "react"
import { useTranslation } from "react-i18next"
import { useRouter } from "@tanstack/react-router"
import { defaultRangeExtractor, useVirtualizer, type Range, type Virtualizer } from "@tanstack/react-virtual"
import { SearchXIcon, SlidersHorizontalIcon, ClapperboardIcon } from "lucide-react"
import { useElementSize } from "@/lib/useElementSize"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { SearchInput } from "@/features/drive/components/searchInput"
import { useDebouncedValue } from "@/lib/useDebouncedValue"
import { log } from "@/lib/log"
import { columnsForWidth } from "@/features/drive/lib/gridLayout"
import { DEFAULT_DENSITY_INDEX, tileSizeForDensity } from "@/features/photos/lib/gridDensity"
import { useVideoCardActions } from "@/features/videos/hooks/useVideoCardActions"
import { useCardFocus } from "@/features/videos/hooks/useCardFocus"
import { cardCommand, cardCommandAction } from "@/features/videos/lib/cardKeys"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { useHistoryEntryKey } from "@/features/videos/hooks/useHistoryEntryKey"
import { recallScroll, rememberScroll } from "@/features/videos/lib/scrollMemory"
import { CardObserver } from "@/features/videos/lib/cardObserver"
import { useGridPrefsQuery, useProbeFactsQuery, useVideosGridDensityQuery, setGridPrefs } from "@/features/videos/queries/grid"
import {
	cachedGridCard,
	fetchGridCard,
	gridPageCard,
	useCatalogGridHeadQuery,
	useCatalogGridPages,
	type GridPages
} from "@/features/videos/queries/catalog"
import { rowLiftPadding, type CardShape } from "@/features/videos/lib/homeRows.logic"
import {
	DEFAULT_GRID_PREFS,
	GRID_QUALITIES,
	GRID_SORTS,
	gridKeyAction,
	gridPrefsKey,
	withActiveRow,
	needsProbeFacts,
	type GridPrefs,
	type GridQuality,
	type GridSort,
	type GridSource,
	type GridWatchFilter
} from "@/features/videos/lib/videoGrid.logic"
import { VideoCard, type VideoCardAction } from "@/features/videos/components/videoCard"
import type { VideoCardModel } from "@/features/videos/lib/homeRows.logic"
import type { GridQuery } from "@/workers/videoIndex/catalog.logic"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { EmptyMessage } from "@/components/emptyMessage"

const GRID_GAP = 16
const GRID_OVERSCAN = 2
// Title and year under a card.
const CAPTION_HEIGHT = 46
const PHONE_WIDTH = 640
// A landscape card's target width against the density's poster width.
const LANDSCAPE_TILE_SCALE = 4 / 3

const SORT_KEYS = {
	title: "videosGridSortTitle",
	added: "videosGridSortAdded",
	year: "videosGridSortYear",
	runtime: "videosGridSortRuntime",
	played: "videosGridSortPlayed",
	random: "videosGridSortRandom"
} as const satisfies Record<GridSort, string>

const QUALITY_KEYS = {
	all: "videosGridQualityAll",
	"2160": "videosGridQuality2160",
	"1080": "videosGridQuality1080",
	"720": "videosGridQuality720",
	sd: "videosGridQualitySd"
} as const satisfies Record<GridQuality, string>

const WATCH_CHIPS: readonly {
	value: GridWatchFilter
	key: "videosGridFilterAll" | "videosGridFilterUnwatched" | "videosGridFilterInProgress" | "videosGridFilterWatched"
}[] = [
	{ value: "all", key: "videosGridFilterAll" },
	{ value: "unwatched", key: "videosGridFilterUnwatched" },
	{ value: "inProgress", key: "videosGridFilterInProgress" },
	{ value: "watched", key: "videosGridFilterWatched" }
]

// Before the first pages render (at transition priority, after the empty grid's first frame).
const NO_PAGES: GridPages = { first: 0, pages: [] }

// One session seed for the Random sort, so it reads the same until the page reloads.
const RANDOM_SEED = Math.floor(Math.random() * 0x7fffffff)

const SEARCH_DEBOUNCE_MS = 150

function searchLabelKey(source: GridSource): "videosGridSearchMovies" | "videosGridSearchShows" | "videosGridSearchTitles" {
	return source.kind === "movies"
		? "videosGridSearchMovies"
		: source.kind === "shows"
			? "videosGridSearchShows"
			: "videosGridSearchTitles"
}

interface GridControlsProps {
	prefs: GridPrefs
	rootOptions: readonly { uuid: string; name: string }[]
	showQuality: boolean
	onChange: (prefs: GridPrefs) => void
}

// Sort, the watch-state chips and the resolution and directory selects: inline on wide panels, in a popover on phones.
function GridControls({ prefs, rootOptions, showQuality, onChange }: GridControlsProps) {
	const { t } = useTranslation("videos")
	const sortItems = GRID_SORTS.map(sort => ({ value: sort, label: t(SORT_KEYS[sort]) }))
	const qualityItems = GRID_QUALITIES.map(quality => ({ value: quality, label: t(QUALITY_KEYS[quality]) }))
	const rootItems = [{ value: "", label: t("videosGridRootAll") }, ...rootOptions.map(root => ({ value: root.uuid, label: root.name }))]

	return (
		<>
			<Select
				items={sortItems}
				value={prefs.sort}
				onValueChange={sort => {
					if (sort !== null) {
						onChange({ ...prefs, sort })
					}
				}}
			>
				<SelectTrigger
					size="sm"
					aria-label={t("videosGridSortLabel")}
					className="min-w-32"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{sortItems.map(item => (
							<SelectItem
								key={item.value}
								value={item.value}
							>
								{item.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
			<div
				role="group"
				aria-label={t("videosGridFilterLabel")}
				className="flex flex-wrap items-center gap-1"
			>
				{WATCH_CHIPS.map(chip => (
					<Button
						key={chip.value}
						variant={prefs.watch === chip.value ? "secondary" : "outline"}
						size="xs"
						className="rounded-full"
						aria-pressed={prefs.watch === chip.value}
						onClick={() => {
							onChange({ ...prefs, watch: chip.value })
						}}
					>
						{t(chip.key)}
					</Button>
				))}
			</div>
			{showQuality ? (
				<Select
					items={qualityItems}
					value={prefs.quality}
					onValueChange={quality => {
						if (quality !== null) {
							onChange({ ...prefs, quality })
						}
					}}
				>
					<SelectTrigger
						size="sm"
						aria-label={t("videosGridQualityLabel")}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{qualityItems.map(item => (
								<SelectItem
									key={item.value}
									value={item.value}
								>
									{item.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			) : null}
			{rootOptions.length > 1 ? (
				<Select
					items={rootItems}
					value={prefs.root}
					onValueChange={root => {
						if (root !== null) {
							onChange({ ...prefs, root })
						}
					}}
				>
					<SelectTrigger
						size="sm"
						aria-label={t("videosGridRootLabel")}
						className="max-w-48"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{rootItems.map(item => (
								<SelectItem
									key={item.value}
									value={item.value}
								>
									{item.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			) : null}
		</>
	)
}

// The grid's virtualizer as its rows component hands it over, for keyboard moves to scroll a row into range. A hook,
// so the grid never reads the ref while rendering.
function useRowScroller() {
	const ref = useRef<Virtualizer<HTMLDivElement, Element> | null>(null)

	return {
		ref,
		scrollToRow: (row: number): void => {
			ref.current?.scrollToIndex(row, { align: "auto" })
		}
	}
}

export interface VideoGridProps {
	source: GridSource
	// The view's name, for the list's accessible name.
	name: string
	// Library directories by uuid, for the directory select.
	rootNames: ReadonlyMap<string, string>
}

// A library view: the Photos-style toolbar (search, sort, watch chips, resolution and directory, count, a coverage
// hint for sorts and filters only a probe can answer) over a virtualized grid of cards. Sort and filters are
// remembered per view.
const IS_MAC = isMacPlatform()

export function VideoGrid({ source, name, rootNames }: VideoGridProps) {
	const { t } = useTranslation("videos")
	const prefsQuery = useGridPrefsQuery(source)
	const densityQuery = useVideosGridDensityQuery()
	const prefs = prefsQuery.data ?? DEFAULT_GRID_PREFS
	const factsQuery = useProbeFactsQuery(needsProbeFacts(prefs))
	const [query, setQuery] = useState("")
	// Typing asks for the grid's order once it pauses; clearing the box at once.
	const settledQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS)
	const gridQuery: GridQuery = { source, prefs, query: query.trim() === "" ? "" : settledQuery, seed: RANDOM_SEED }
	// A sort or filter only a probe can answer waits for the stored probes' facts; when they can't be read, files
	// order as unprobed ones do rather than the grid staying empty.
	const enabled = prefsQuery.status === "success" && (!needsProbeFacts(prefs) || factsQuery.isSuccess || factsQuery.isError)
	const headQuery = useCatalogGridHeadQuery(gridQuery, enabled)
	// The grid lays out at transition priority once its first page lands (in short slices, never one long task).
	const head = useDeferredValue(headQuery.data)
	const total = head?.total ?? 0
	const shape: CardShape = head?.shape ?? (source.kind === "other" ? "landscape" : "poster")
	const onAction = useVideoCardActions()
	const combos = useBindings()
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const { width } = useElementSize(scrollElement)
	const [activeState, setActiveIndex] = useState(0)
	// The card holding focus: its row stays mounted until the card a cursor move asked for took focus over.
	const [focusedState, setFocusedIndex] = useState(0)
	// The card a cursor move asked to focus, until it took focus; bumped `moves` makes an Enter or Play still waiting
	// for its card's page act only if nothing moved since.
	const pendingFocus = useRef<number | null>(null)
	const moves = useRef(0)
	const rowScroller = useRowScroller()
	const cardFocus = useCardFocus<number>()
	const router = useRouter()
	const historyKey = useHistoryEntryKey()
	const scrollKey = `${historyKey}:grid:${gridPrefsKey(source)}`
	const [restoreOffset] = useState(() => recallScroll(scrollKey))

	// Cards within half a screen of the visible part may read and decode art; the overscan rows beyond wait.
	const nearObserver = useMemo(
		() => (scrollElement === null ? null : new CardObserver({ root: scrollElement, rootMargin: "50% 0px", threshold: 0 })),
		[scrollElement]
	)

	useEffect(() => {
		return () => {
			nearObserver?.disconnect()
		}
	}, [nearObserver])

	const contentWidth = width
	const phone = width > 0 && width < PHONE_WIDTH
	const tile = tileSizeForDensity(densityQuery.data ?? DEFAULT_DENSITY_INDEX) * (shape === "landscape" ? LANDSCAPE_TILE_SCALE : 1)
	const columns = phone ? (shape === "poster" ? 3 : 2) : columnsForWidth(contentWidth, tile, GRID_GAP)
	const cardWidth = columns > 0 ? (contentWidth - GRID_GAP * (columns - 1)) / columns : 0
	const artHeight = Math.round(cardWidth * (shape === "poster" ? 1.5 : 9 / 16))
	const rowHeight = artHeight + CAPTION_HEIGHT
	const rowCount = columns > 0 ? Math.ceil(total / columns) : 0
	const activeIndex = Math.max(0, Math.min(activeState, total - 1))
	const focusedIndex = Math.max(0, Math.min(focusedState, total - 1))
	const rootOptions = (head?.rootOptions ?? []).map(uuid => ({ uuid, name: rootNames.get(uuid) ?? "" }))
	const showQuality = source.kind !== "shows"
	const filtersActive = prefs.watch !== "all" || prefs.quality !== "all" || prefs.root !== "" || query.length > 0

	function updatePrefs(next: GridPrefs): void {
		setGridPrefs(source, next)
		pendingFocus.current = null
		setActiveIndex(0)
		scrollElement?.scrollTo({ top: 0 })
	}

	// The cursor's card may not be on screen yet (its page on the way): `act` runs on it once it is, unless the cursor
	// moved on meanwhile.
	function actOnCursor(act: (card: VideoCardModel) => void): void {
		const move = moves.current
		const run = (card: VideoCardModel | undefined): void => {
			if (card !== undefined && move === moves.current) {
				act(card)
			}
		}
		const cached = cachedGridCard(gridQuery, activeIndex)

		if (cached !== undefined) {
			run(cached)
		} else {
			fetchGridCard(gridQuery, activeIndex).then(run, (e: unknown) => {
				log.warn("videos.grid", "loading the card under the cursor failed", e)
			})
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		const target = event.target

		if (!(target instanceof HTMLAnchorElement) || !target.hasAttribute("data-video-card") || isRecordingCombo()) {
			return
		}

		const command = cardCommand(event, combos, IS_MAC)

		if (command !== null) {
			event.preventDefault()

			if (!event.repeat) {
				actOnCursor(card => {
					const action = cardCommandAction(command, card)

					if (action !== null) {
						onAction(action, card)
					}
				})
			}

			return
		}

		if (event.altKey || event.ctrlKey || event.metaKey) {
			return
		}

		const action = gridKeyAction({
			key: event.key,
			index: activeIndex,
			count: total,
			columns,
			pageRows: Math.max(1, Math.floor((scrollElement?.clientHeight ?? 0) / (rowHeight + GRID_GAP)))
		})

		// Enter on the card holding focus opens it natively; while a cursor move waits for its card, that card opens.
		if (action.kind === "none" || (action.kind === "open" && pendingFocus.current === null)) {
			return
		}

		event.preventDefault()

		if (action.kind === "open") {
			actOnCursor(card => {
				void router.navigate({ to: "/videos/title/$uuid", params: { uuid: card.title.id } })
			})

			return
		}

		moves.current++
		pendingFocus.current = action.index
		setActiveIndex(action.index)
		rowScroller.scrollToRow(Math.floor(action.index / columns))
		cardFocus.focus(action.index, { scroll: false })
	}

	// The toolbar shows at once; the grid (and its counts) once the library's worker sent the first page.
	if (prefsQuery.status === "pending") {
		return null
	}

	const controls = (
		<GridControls
			prefs={prefs}
			rootOptions={rootOptions}
			showQuality={showQuality}
			onChange={updatePrefs}
		/>
	)

	let body: ReactNode

	if (head?.sourceCount === 0) {
		body = (
			<div className="flex flex-1 overflow-y-auto">
				<EmptyMessage
					icon={ClapperboardIcon}
					title={t("videosGridEmptyTitle")}
					description={t("videosGridEmptyBody")}
				/>
			</div>
		)
	} else if (head !== undefined && total === 0) {
		body = (
			<div className="flex flex-1 overflow-y-auto">
				<EmptyMessage
					icon={SearchXIcon}
					title={t("videosGridNoMatchesTitle")}
					description={t("videosGridNoMatchesBody")}
				>
					<Button
						variant="outline"
						onClick={() => {
							setQuery("")
							updatePrefs({ ...prefs, watch: "all", quality: "all", root: "" })
						}}
					>
						{t("videosGridClearFilters")}
					</Button>
				</EmptyMessage>
			</div>
		)
	} else {
		body = null
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3">
				<SearchInput
					action="videos.search"
					label={t(searchLabelKey(source))}
					value={query}
					onChange={next => {
						setQuery(next)
						setActiveIndex(0)
					}}
					onClear={() => {
						setQuery("")
					}}
				/>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2 max-sm:hidden">{controls}</div>
				<Popover>
					<PopoverTrigger
						render={
							<Button
								variant={filtersActive ? "secondary" : "outline"}
								size="sm"
								className="sm:hidden"
							>
								<SlidersHorizontalIcon data-icon="inline-start" />
								{t("videosGridFilters")}
							</Button>
						}
					/>
					<PopoverContent
						align="end"
						className="flex w-72 flex-col items-start gap-3"
					>
						{controls}
					</PopoverContent>
				</Popover>
				<span
					role="status"
					className="ml-auto text-xs text-muted-foreground tabular-nums"
				>
					{head === undefined ? "" : t("videosGridCount", { count: total })}
				</span>
			</div>
			{head !== undefined && head.coverage !== null && head.coverage.known < head.coverage.total ? (
				<p className="shrink-0 px-4 pb-2 text-xs text-muted-foreground tabular-nums">
					{head.coverage.kind === "runtime"
						? t("videosGridCoverageRuntime", { known: head.coverage.known, total: head.coverage.total })
						: t("videosGridCoverageQuality", { known: head.coverage.known, total: head.coverage.total })}
				</p>
			) : null}
			{body ?? (
				<div
					ref={setScrollElement}
					role="list"
					aria-label={t("videosGridLabel", { name })}
					className="min-h-0 flex-1 overflow-y-auto px-4 pb-6"
					style={{ paddingTop: rowLiftPadding(artHeight) }}
					onKeyDown={handleKeyDown}
					onScroll={event => {
						rememberScroll(scrollKey, event.currentTarget.scrollTop)
					}}
				>
					{width > 0 && head !== undefined ? (
						<VideoGridRows
							scrollElement={scrollElement}
							gridQuery={gridQuery}
							enabled={enabled}
							total={total}
							rowCount={rowCount}
							columns={columns}
							rowHeight={rowHeight}
							cardWidth={cardWidth}
							activeIndex={activeIndex}
							focusedIndex={focusedIndex}
							nearObserver={nearObserver}
							restoreOffset={restoreOffset}
							registerCard={cardFocus.register}
							virtualizerRef={rowScroller.ref}
							onFocusCard={index => {
								if (pendingFocus.current === index) {
									pendingFocus.current = null
								}

								setActiveIndex(index)
								setFocusedIndex(index)
							}}
							onAction={onAction}
						/>
					) : null}
				</div>
			)}
		</div>
	)
}

interface GridCardProps {
	card: VideoCardModel
	index: number
	setSize: number
	active: boolean
	nearObserver: CardObserver | null
	registerCard: (index: number, element: HTMLAnchorElement | null) => void
	onFocusCard: (index: number) => void
	onAction: (action: VideoCardAction, card: VideoCardModel) => void
}

// Compiled, unlike the virtualizer host around it: builds the card's callbacks from what it is given, so a scroll step
// or cursor move leaves every card whose props didn't change as it was.
function GridCard({ card, index, setSize, active, nearObserver, registerCard, onFocusCard, onAction }: GridCardProps) {
	return (
		<VideoCard
			card={card}
			nearObserver={nearObserver}
			active={active}
			posInSet={index + 1}
			setSize={setSize}
			registerRef={element => {
				registerCard(index, element)
			}}
			onFocusCard={() => {
				onFocusCard(index)
			}}
			onAction={onAction}
		/>
	)
}

interface VideoGridRowsProps {
	scrollElement: HTMLDivElement | null
	gridQuery: GridQuery
	enabled: boolean
	total: number
	rowCount: number
	columns: number
	rowHeight: number
	cardWidth: number
	activeIndex: number
	focusedIndex: number
	nearObserver: CardObserver | null
	// Where Back left the list, applied once the rows are laid out.
	restoreOffset: number | undefined
	registerCard: (index: number, element: HTMLAnchorElement | null) => void
	virtualizerRef: RefObject<Virtualizer<HTMLDivElement, Element> | null>
	onFocusCard: (index: number) => void
	onAction: (action: VideoCardAction, card: VideoCardModel) => void
}

// Owns the virtualizer, which opts its host out of the React Compiler and re-renders it on every range change; split
// out so VideoGrid compiles. Only the pages holding the rendered rows are fetched from the library's worker; a card
// whose page hasn't arrived keeps its slot empty. The rows holding the cursor and the focused card stay mounted when
// scrolled away, so focus never drops (while a cursor move waits for its card, too).
function VideoGridRows({
	scrollElement,
	gridQuery,
	enabled,
	total,
	rowCount,
	columns,
	rowHeight,
	cardWidth,
	activeIndex,
	focusedIndex,
	nearObserver,
	restoreOffset,
	registerCard,
	virtualizerRef,
	onFocusCard,
	onAction
}: VideoGridRowsProps) {
	// Changing with the layout is what makes the virtualizer re-read row sizes; stable while scrolling.
	const getRowKey = useCallback((index: number) => `${String(columns)}:${String(rowHeight)}:${String(index)}`, [columns, rowHeight])
	const activeRow = Math.floor(activeIndex / columns)
	const focusedRow = Math.floor(focusedIndex / columns)
	const rangeExtractor = useCallback(
		(range: Range) => withActiveRow(withActiveRow(defaultRangeExtractor(range), activeRow, range.count), focusedRow, range.count),
		[activeRow, focusedRow]
	)
	const virtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => rowHeight,
		gap: GRID_GAP,
		overscan: GRID_OVERSCAN,
		getItemKey: getRowKey,
		rangeExtractor
	})
	const restored = useRef(false)

	useLayoutEffect(() => {
		virtualizerRef.current = virtualizer

		return () => {
			virtualizerRef.current = null
		}
	}, [virtualizer, virtualizerRef])

	const totalSize = virtualizer.getTotalSize()
	const virtualRows = virtualizer.getVirtualItems()
	const firstCard = (virtualRows[0]?.index ?? 0) * columns
	const lastCard = Math.min(total, ((virtualRows.at(-1)?.index ?? -1) + 1) * columns) - 1
	const fetched = useCatalogGridPages(gridQuery, firstCard, lastCard, enabled)
	// Cards render at transition priority (in short slices): the first screen of cards or a page landing never lays
	// out in one task.
	const pages = useDeferredValue(fetched, NO_PAGES)

	useLayoutEffect(() => {
		if (restored.current || restoreOffset === undefined || scrollElement === null || totalSize === 0) {
			return
		}

		restored.current = true
		scrollElement.scrollTo({ top: restoreOffset })
	}, [restoreOffset, scrollElement, totalSize])

	return (
		<div style={{ position: "relative", width: "100%", height: totalSize }}>
			{virtualRows.map(virtualRow => {
				const start = virtualRow.index * columns
				const indices: number[] = []

				for (let index = start; index < Math.min(total, start + columns); index++) {
					indices.push(index)
				}

				return (
					<div
						key={virtualRow.key}
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							height: virtualRow.size,
							transform: `translateY(${String(virtualRow.start)}px)`,
							display: "grid",
							gridTemplateColumns: `repeat(${String(columns)}, ${String(cardWidth)}px)`,
							columnGap: GRID_GAP
						}}
					>
						{indices.map(index => {
							const card = gridPageCard(pages, index)

							return card === undefined ? (
								<div
									key={`slot:${String(index)}`}
									aria-hidden="true"
								/>
							) : (
								<GridCard
									key={card.key}
									card={card}
									index={index}
									setSize={total}
									active={index === activeIndex}
									nearObserver={nearObserver}
									registerCard={registerCard}
									onFocusCard={onFocusCard}
									onAction={onAction}
								/>
							)
						})}
					</div>
				)
			})}
		</div>
	)
}
