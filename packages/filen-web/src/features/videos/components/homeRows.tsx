import { startTransition, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Link } from "@tanstack/react-router"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { useElementSize } from "@/lib/useElementSize"
import { prefersReducedMotion } from "@/lib/motion"
import { useVideoRootNames } from "@/features/videos/hooks/useVideoLibraryView"
import { useWatchStateLoaded } from "@/features/videos/hooks/useWatchStateLoaded"
import { useCatalogHomeQuery } from "@/features/videos/queries/catalog"
import { useVideoCardActions } from "@/features/videos/hooks/useVideoCardActions"
import { useCardFocus } from "@/features/videos/hooks/useCardFocus"
import { cardCommand, cardCommandAction } from "@/features/videos/lib/cardKeys"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { useHistoryEntryKey } from "@/features/videos/hooks/useHistoryEntryKey"
import { recallScroll, rememberScroll } from "@/features/videos/lib/scrollMemory"
import { CardObserver } from "@/features/videos/lib/cardObserver"
import {
	CARD_GAP,
	cardsInView,
	peekCardWidth,
	rowLiftPadding,
	seeAllTarget,
	type HomeRowModel,
	type VideoCardModel
} from "@/features/videos/lib/homeRows.logic"
import { rowsKeyAction } from "@/features/videos/lib/videoGrid.logic"
import type { VideoLibraryRootView } from "@/features/videos/lib/libraryView.logic"
import { VideoCard, type VideoCardAction } from "@/features/videos/components/videoCard"
import { HomeHero } from "@/features/videos/components/homeHero"
import { minuteStamp } from "@/lib/useNowMinute"

// The rows' inline padding: cards start this far in, and the last card is cut at the panel's edge.
const ROW_INSET = 16
// Caption under a card: the title and up to two lines.
const CAPTION_HEIGHT = 58
const ROW_HEADER_HEIGHT = 28

const IS_MAC = isMacPlatform()

// One hero per session: kept while it stays in the library.
let sessionHeroId: string | null = null
const sessionHeroSeed = Math.random()

function rememberHero(id: string | null): void {
	sessionHeroId = id
}

function sessionHero(): string | null {
	return sessionHeroId
}

const NO_ROWS: readonly HomeRowModel[] = []

interface RowCursor {
	row: string
	column: number
}

interface RowCardProps {
	card: VideoCardModel
	column: number
	width: number
	active: boolean
	nearObserver: CardObserver | null
	registerCard: (column: number, element: HTMLAnchorElement | null) => void
	onFocusColumn: (column: number) => void
	onAction: (action: VideoCardAction, card: VideoCardModel) => void
}

// Builds the card's callbacks from primitives, so a cursor move re-renders only the two cards it touches: every other
// card gets the same props and keeps its rendered output.
function RowCard({ card, column, width, active, nearObserver, registerCard, onFocusColumn, onAction }: RowCardProps) {
	return (
		<VideoCard
			card={card}
			width={width}
			nearObserver={nearObserver}
			active={active}
			registerRef={element => {
				registerCard(column, element)
			}}
			onFocusCard={() => {
				onFocusColumn(column)
			}}
			onAction={onAction}
		/>
	)
}

interface HomeRowProps {
	row: HomeRowModel
	heading: string
	cardWidth: number
	// Cards mounted before the row is scrolled, pointed at or focused: the ones in view and the next.
	initialCards: number
	// The cursor's column in this row, -1 when it is in another.
	activeColumn: number
	// Rows within a viewport of the screen mount their cards.
	mountObserver: CardObserver | null
	// Rows within half a viewport may read and decode art.
	artObserver: CardObserver | null
	historyKey: string
	registerCard: (key: string, element: HTMLAnchorElement | null) => void
	onFocusCard: (row: string, column: number) => void
	onAction: (action: VideoCardAction, card: VideoCardModel) => void
}

const CHEVRON_CLASS =
	"absolute top-1/2 hidden size-8 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 shadow-md ring-1 ring-foreground/10 pointer-fine:group-hover/row:flex group-has-[a:focus-visible]/row:flex"

// One horizontal row: a labelled list on native scroll-snap. Its cards mount only while the row is within a viewport
// of the screen (or holds the cursor), and a card's art is read only within half a viewport and near the row's
// visible part. Its scroll position comes back with Back.
function HomeRow({
	row,
	heading,
	cardWidth,
	initialCards,
	activeColumn,
	mountObserver,
	artObserver,
	historyKey,
	registerCard,
	onFocusCard,
	onAction
}: HomeRowProps) {
	const { t } = useTranslation("videos")
	const headingId = useId()
	const [section, setSection] = useState<HTMLElement | null>(null)
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
	const [near, setNear] = useState(false)
	const [artNear, setArtNear] = useState(false)
	const mounted = near || activeColumn >= 0
	const rowId = row.id
	const scrollKey = `${historyKey}:home:${rowId}`
	// The cards past the row's visible part mount once the row is scrolled, pointed at or focused (or holds the
	// cursor past them, or comes back scrolled with Back): a home of rows lays out only what shows.
	const [expandedState, setExpanded] = useState(() => recallScroll(scrollKey) !== undefined)
	const expanded = expandedState || activeColumn >= initialCards - 1
	const cards = expanded ? row.cards : row.cards.slice(0, initialCards)

	function expand(): void {
		if (!expandedState) {
			startTransition(() => {
				setExpanded(true)
			})
		}
	}

	// A row coming near mounts its cards at transition priority (in short slices, never one long task).
	useEffect(() => {
		if (section === null || mountObserver === null) {
			return
		}

		return mountObserver.observe(section, value => {
			startTransition(() => {
				setNear(value)
			})
		})
	}, [section, mountObserver])

	useEffect(() => {
		if (section === null || artObserver === null) {
			return
		}

		return artObserver.observe(section, setArtNear)
	}, [section, artObserver])

	// Cards near the row's visible part: half a row's width either side.
	const cardObserver = useMemo(
		() => (scroller === null || !mounted ? null : new CardObserver({ root: scroller, rootMargin: "0px 50%", threshold: 0 })),
		[scroller, mounted]
	)

	useEffect(() => {
		return () => {
			cardObserver?.disconnect()
		}
	}, [cardObserver])

	// Back to this entry: the row scrolls where it was, once its cards are there.
	useLayoutEffect(() => {
		const saved = recallScroll(scrollKey)

		if (scroller !== null && mounted && saved !== undefined && scroller.scrollLeft === 0) {
			scroller.scrollTo({ left: saved })
		}
	}, [scroller, mounted, scrollKey])

	const registerColumn = (column: number, element: HTMLAnchorElement | null): void => {
		registerCard(`${rowId}:${String(column)}`, element)
	}
	const focusColumn = (column: number): void => {
		onFocusCard(rowId, column)
	}
	const artHeight = Math.round(cardWidth * (row.shape === "poster" ? 1.5 : 9 / 16))
	const liftPadding = rowLiftPadding(artHeight)
	const rowHeight = artHeight + CAPTION_HEIGHT + 2 * liftPadding
	const target = seeAllTarget(row)

	function scrollRow(direction: 1 | -1): void {
		scroller?.scrollBy({ left: direction * scroller.clientWidth * 0.8, behavior: prefersReducedMotion() ? "auto" : "smooth" })
	}

	return (
		<section
			ref={setSection}
			aria-labelledby={headingId}
			className="group/row relative flex flex-col [content-visibility:auto]"
			style={{ containIntrinsicSize: `auto ${String(ROW_HEADER_HEIGHT + rowHeight)}px` }}
		>
			<div className="flex h-7 items-baseline justify-between gap-3 px-4">
				<h2
					id={headingId}
					className="truncate text-sm font-medium"
				>
					{heading}
				</h2>
				{target === null ? null : (
					<Link
						to={target}
						params={{ uuid: row.rootUuid ?? "" }}
						aria-label={t("videosHomeSeeAllLabel", { row: heading })}
						className="shrink-0 rounded-md text-xs text-muted-foreground focus-ring outline-none hover:text-foreground"
					>
						{t("videosHomeSeeAll")}
					</Link>
				)}
			</div>
			<div className="relative">
				<div
					ref={setScroller}
					role="list"
					aria-labelledby={headingId}
					className="flex snap-x snap-proximity scroll-px-4 [scrollbar-width:none] overflow-x-auto overscroll-x-contain px-4 [&::-webkit-scrollbar]:hidden"
					style={{ gap: CARD_GAP, minHeight: rowHeight, paddingBlock: liftPadding }}
					onScroll={event => {
						rememberScroll(scrollKey, event.currentTarget.scrollLeft)
						expand()
					}}
					onPointerEnter={expand}
					onFocus={expand}
				>
					{mounted
						? cards.map((card, column) => (
								<RowCard
									key={card.key}
									card={card}
									column={column}
									width={cardWidth}
									active={column === activeColumn}
									nearObserver={artNear ? cardObserver : null}
									registerCard={registerColumn}
									onFocusColumn={focusColumn}
									onAction={onAction}
								/>
							))
						: null}
				</div>
				{/* Edge fade over the cut card: a plain gradient layer, so the row never pays for a mask. */}
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-linear-to-l from-card to-transparent"
				/>
				<button
					type="button"
					tabIndex={-1}
					aria-label={t("videosHomeScrollBack")}
					className={cn(CHEVRON_CLASS, "left-1")}
					onClick={() => {
						scrollRow(-1)
					}}
				>
					<ChevronLeftIcon className="size-4" />
				</button>
				<button
					type="button"
					tabIndex={-1}
					aria-label={t("videosHomeScrollForward")}
					className={cn(CHEVRON_CLASS, "right-1")}
					onClick={() => {
						scrollRow(1)
					}}
				>
					<ChevronRightIcon className="size-4" />
				</button>
			</div>
		</section>
	)
}

function rowHeading({ row, names, t }: { row: HomeRowModel; names: ReadonlyMap<string, string>; t: TFunction<"videos"> }): string {
	switch (row.kind) {
		case "continue":
			return t("videosHomeContinueWatching")
		case "latestMovies":
			return t("videosHomeLatestMovies")
		case "latestEpisodes":
			return t("videosHomeLatestEpisodes")
		case "movies":
			return t("videosMovies")
		case "shows":
			return t("videosShows")
		case "other":
			return t("videosOther")
		case "root":
			return names.get(row.rootUuid ?? "") ?? ""
	}
}

// The rows and the hero, built in the library's worker from what it holds and the watch state; fetched again when
// either changes. A hook of its own, so the cursor state of the component using them never joins their memoization.
function useHomeRows(roots: readonly VideoLibraryRootView[]) {
	// Fixed per mount, so the rows don't move while they are looked at; on the minute, so Back within it reuses the rows
	// already fetched.
	const [now] = useState(() => minuteStamp(Date.now()))
	// The first rows wait (briefly) for the local watch state, so Continue Watching doesn't push the others down.
	const watchLoaded = useWatchStateLoaded()
	const query = useCatalogHomeQuery(
		{ roots: roots.filter(root => root.enabled).map(root => root.uuid), now, heroSeed: sessionHeroSeed },
		sessionHero,
		watchLoaded
	)

	// The rows render at transition priority, so React lays a whole home of cards out in short slices rather than one
	// long task.
	const data = useDeferredValue(query.data)

	return { rows: data?.rows ?? NO_ROWS, hero: data?.hero ?? null, ready: data !== undefined, now }
}

// The cursor and a focus handler that stays the same function across cursor moves, so the cards it is passed to
// keep their output.
function useRowCursor() {
	const [cursorState, setCursor] = useState<RowCursor>({ row: "", column: 0 })
	const focusCard = (row: string, column: number): void => {
		setCursor({ row, column })
	}

	return { cursorState, setCursor, focusCard }
}

// The home under the header: the hero, then the rows. One roving cursor spans every row (Left/Right within a row,
// Up/Down between rows keeping the column, Esc back); rows mount within a viewport of the screen and the row holding
// the cursor stays mounted. The page's and each row's scroll position come back with Back.
export function VideosHomeRows({ roots, scrollElement }: { roots: readonly VideoLibraryRootView[]; scrollElement: HTMLElement | null }) {
	const { t } = useTranslation("videos")
	const { rows, hero, ready: rowsReady, now } = useHomeRows(roots)
	const names = useVideoRootNames(roots)
	const onAction = useVideoCardActions()
	const combos = useBindings()
	const historyKey = useHistoryEntryKey()
	const [container, setContainer] = useState<HTMLDivElement | null>(null)
	const { width } = useElementSize(container)
	const { cursorState, setCursor, focusCard } = useRowCursor()
	const cardFocus = useCardFocus<string>()
	const pageKey = `${historyKey}:home`

	// Rows within one viewport above or below the visible part of the screen mount; within half a viewport they read
	// art.
	const mountObserver = useMemo(
		() => (scrollElement === null ? null : new CardObserver({ root: scrollElement, rootMargin: "100% 0px", threshold: 0 })),
		[scrollElement]
	)
	const artObserver = useMemo(
		() => (scrollElement === null ? null : new CardObserver({ root: scrollElement, rootMargin: "50% 0px", threshold: 0 })),
		[scrollElement]
	)

	useEffect(() => {
		return () => {
			mountObserver?.disconnect()
			artObserver?.disconnect()
		}
	}, [mountObserver, artObserver])

	useEffect(() => {
		if (scrollElement === null) {
			return
		}

		const onScroll = (): void => {
			rememberScroll(pageKey, scrollElement.scrollTop)
		}

		scrollElement.addEventListener("scroll", onScroll, { passive: true })

		return () => {
			scrollElement.removeEventListener("scroll", onScroll)
		}
	}, [scrollElement, pageKey])

	const ready = width > 0 && rowsReady

	// Back to this entry: the page scrolls where it was once the rows are laid out.
	useLayoutEffect(() => {
		const saved = recallScroll(pageKey)

		if (ready && scrollElement !== null && saved !== undefined && scrollElement.scrollTop === 0) {
			scrollElement.scrollTo({ top: saved })
		}
	}, [ready, scrollElement, pageKey])

	const rowLengths = rows.map(row => row.cards.length)
	const cursorRow = rows.findIndex(row => row.id === cursorState.row)
	const cursor: RowCursor =
		cursorRow === -1
			? { row: rows[0]?.id ?? "", column: 0 }
			: { row: cursorState.row, column: Math.min(cursorState.column, Math.max(0, (rowLengths[cursorRow] ?? 1) - 1)) }
	const rowRange = Math.max(0, width - ROW_INSET)
	const posterWidth = peekCardWidth({ rowWidth: rowRange, shape: "poster" })
	const landscapeWidth = peekCardWidth({ rowWidth: rowRange, shape: "landscape" })

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		const target = event.target

		if (!(target instanceof HTMLAnchorElement) || !target.hasAttribute("data-video-card") || isRecordingCombo()) {
			return
		}

		const row = rows.findIndex(candidate => candidate.id === cursor.row)
		const command = cardCommand(event, combos, IS_MAC)

		if (command !== null) {
			event.preventDefault()

			const card = rows[row]?.cards[cursor.column]
			const action = card === undefined || event.repeat ? null : cardCommandAction(command, card)

			if (card !== undefined && action !== null) {
				onAction(action, card)
			}

			return
		}

		if (event.altKey || event.ctrlKey || event.metaKey) {
			return
		}

		const action = rowsKeyAction({ key: event.key, row, column: cursor.column, rowLengths })

		if (action.kind === "none" || action.kind === "open") {
			return
		}

		event.preventDefault()

		const next = rows[action.row]

		if (next === undefined) {
			return
		}

		setCursor({ row: next.id, column: action.column })
		cardFocus.focus(`${next.id}:${String(action.column)}`, { scroll: true })
	}

	return (
		<div
			ref={setContainer}
			className="flex flex-col gap-3 pb-6"
			onKeyDown={handleKeyDown}
		>
			{hero === null ? null : (
				<div className="px-4 pb-3">
					<HomeHero
						hero={hero}
						now={now}
						onShown={rememberHero}
					/>
				</div>
			)}
			{width === 0
				? null
				: rows.map(row => (
						<HomeRow
							key={row.id}
							row={row}
							heading={rowHeading({ row, names, t })}
							cardWidth={row.shape === "poster" ? posterWidth : landscapeWidth}
							initialCards={Math.ceil(cardsInView(rowRange, row.shape)) + 1}
							activeColumn={cursor.row === row.id ? cursor.column : -1}
							mountObserver={mountObserver}
							artObserver={artObserver}
							historyKey={historyKey}
							registerCard={cardFocus.register}
							onFocusCard={focusCard}
							onAction={onAction}
						/>
					))}
		</div>
	)
}
