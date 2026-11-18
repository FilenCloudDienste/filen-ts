import {
	useEffect,
	useEffectEvent,
	useRef,
	useState,
	useSyncExternalStore,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode
} from "react"
import { useTranslation } from "react-i18next"
import type { TextPagerReading } from "@/features/preview/hooks/useTextPagerSession"
import type { PagerRowView } from "@/features/preview/workers/textPager.worker"
import {
	appendRows,
	nextLine,
	placedWindow,
	prependRows,
	scrollWindow,
	visibleRows,
	wantsAfter,
	wantsBefore,
	type PagerWindow,
	type PositionStore,
	type WindowBounds
} from "@/features/preview/lib/textPager/viewport.logic"

// The large text viewer's rows: a fixed-height row per line (or per piece of a long one), no wrapping, scrolled by the
// byte offset of the first row shown. Wheel, keys, touch drags and its own scrollbar move it; nothing outside the few
// screens of rows it holds is ever laid out.

// Where to go: a byte offset, with up to `before` rows shown above its row. A match marks the offset as the active one.
export interface PagerJump {
	readonly seq: number
	readonly offset: number
	readonly before: number
	readonly line: number | null
	readonly match: boolean
}

interface ViewState extends PagerWindow<PagerRowView> {
	// Bumped by every jump: rows asked for before it are dropped.
	readonly generation: number
	// The active match: its row and how many units into the row it starts.
	readonly active: { readonly start: number; readonly column: number } | null
}

const THUMB_PX = 32
const MATCH_CLASS = "rounded-[2px] bg-[color-mix(in_oklab,#facc15_35%,transparent)] text-inherit"
const ACTIVE_CLASS = "rounded-[2px] bg-[color-mix(in_oklab,#f97316_45%,transparent)] text-inherit"

function RowText({ text, pattern, active }: { text: string; pattern: RegExp | null; active: number | null }): ReactNode {
	if (pattern === null || text === "") {
		return text
	}

	const parts: ReactNode[] = []
	let last = 0

	// matchAll runs on a copy of the pattern: the shared one is never touched.
	for (const match of text.matchAll(pattern)) {
		if (match.index > last) parts.push(text.slice(last, match.index))

		parts.push(
			<mark
				key={match.index}
				className={match.index === active ? ACTIVE_CLASS : MATCH_CLASS}
				{...(match.index === active ? { "data-active-match": true } : {})}
			>
				{match[0]}
			</mark>
		)
		last = match.index + match[0].length
	}

	parts.push(text.slice(last))

	return parts
}

export function LargeTextRows({
	reading,
	alt,
	fontSize,
	pattern,
	jump,
	linesVersion,
	position
}: {
	reading: TextPagerReading
	alt: string
	fontSize: number
	// Matches to mark in the rows shown; null while not finding.
	pattern: RegExp | null
	jump: PagerJump | null
	// Bumped when more lines are counted: the rows held are asked for again with their numbers.
	linesVersion: number
	position: PositionStore
}) {
	const { t } = useTranslation("preview")
	const { pager, start, size, fail } = reading
	const rowHeight = Math.round(fontSize * 1.5)
	const [height, setHeight] = useState(600)
	const bounds: WindowBounds = { start, size, rowHeight, height }
	const shown = visibleRows(bounds)
	const [view, setView] = useState<ViewState>({ rows: [], top: 0, shift: 0, generation: 0, active: null })
	const [drag, setDrag] = useState<number | null>(null)
	const at = useSyncExternalStore(position.subscribe, position.get)
	const generation = useRef(0)
	const fetching = useRef({ before: false, after: false })
	// A scrollbar drag asks for one position at a time; the latest asked meanwhile follows.
	const seeking = useRef<{ busy: boolean; next: number | null }>({ busy: false, next: null })
	const touch = useRef<number | null>(null)
	const grab = useRef<number | null>(null)
	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const trackRef = useRef<HTMLDivElement | null>(null)

	const locate = (offset: number, before: number, line: number | null, match: boolean): Promise<void> => {
		const seq = ++generation.current

		fetching.current = { before: false, after: false }

		return pager
			.run(remote => remote.locate(offset, before, 2 * shown, line))
			.then(
				result => {
					if (generation.current !== seq) {
						return
					}

					const focused = result.rows[result.focus]

					setView({
						...placedWindow(result.rows, result.focus, before, bounds),
						generation: seq,
						active: match && focused !== undefined ? { start: focused.start, column: result.column } : null
					})
				},
				(error: unknown) => {
					fail(error)
				}
			)
	}

	const seek = (offset: number): void => {
		if (seeking.current.busy) {
			seeking.current.next = offset

			return
		}

		seeking.current.busy = true
		void locate(offset, 0, null, false).then(() => {
			const next = seeking.current.next

			seeking.current = { busy: false, next: null }

			if (next !== null) seek(next)
		})
	}

	const scrollBy = (delta: number): void => {
		setView(current => ({ ...current, ...scrollWindow(current, delta, bounds) }))
	}

	const goTo = useEffectEvent((target: PagerJump) => {
		void locate(target.offset, target.before, target.line, target.match)
	})

	useEffect(() => {
		goTo(jump ?? { seq: 0, offset: start, before: 0, line: 1, match: false })
	}, [jump, start])

	// Rows above and below as the view nears either end of what it holds.
	const fill = useEffectEvent((current: ViewState) => {
		const first = current.rows[0]
		const last = current.rows.at(-1)
		const seq = current.generation

		if (first !== undefined && !fetching.current.before && wantsBefore(current, bounds)) {
			fetching.current.before = true
			void pager
				.run(remote => remote.before(first.start, 2 * shown, first.line))
				.then(
					more => {
						if (generation.current === seq) fetching.current.before = false

						setView(previous =>
							previous.generation === seq && previous.rows[0]?.start === first.start && more.length > 0
								? { ...previous, ...prependRows(previous, more, bounds) }
								: previous
						)
					},
					(error: unknown) => {
						fetching.current.before = false
						fail(error)
					}
				)
		}

		if (last !== undefined && !fetching.current.after && wantsAfter(current, bounds)) {
			fetching.current.after = true
			void pager
				.run(remote => remote.after(last.end, !last.breaks, 2 * shown, nextLine(last)))
				.then(
					more => {
						if (generation.current === seq) fetching.current.after = false

						setView(previous =>
							previous.generation === seq && previous.rows.at(-1)?.end === last.end && more.length > 0
								? { ...previous, ...appendRows(previous, more, bounds) }
								: previous
						)
					},
					(error: unknown) => {
						fetching.current.after = false
						fail(error)
					}
				)
		}
	})

	useEffect(() => {
		fill(view)
	}, [view, height, rowHeight])

	// The rows held, asked for again once lines are counted further, so their numbers show.
	const renumber = useEffectEvent(() => {
		const first = view.rows[0]
		const seq = view.generation

		if (first === undefined) {
			return
		}

		void pager
			.run(remote => remote.after(first.start, first.continuation, view.rows.length, null))
			.then(
				rows => {
					setView(previous =>
						previous.generation === seq && previous.rows[0]?.start === first.start && rows.length === previous.rows.length
							? { ...previous, rows }
							: previous
					)
				},
				(error: unknown) => {
					fail(error)
				}
			)
	})

	useEffect(() => {
		if (linesVersion > 0) renumber()
	}, [linesVersion])

	const publish = useEffectEvent((current: ViewState) => {
		const first = current.rows[current.top]
		const last = current.rows.at(-1)
		const end = last !== undefined && last.end >= size && current.rows.length - current.top <= Math.floor(height / rowHeight)

		if (first !== undefined) position.set(end ? size : first.start)
	})

	useEffect(() => {
		publish(view)
	}, [view])

	const activeStart = view.active?.start ?? null
	const activeColumn = view.active?.column ?? null

	// A match just made active is brought into view sideways, once: scrolling afterwards is the user's. Only this
	// scroller moves (its rows are always in view vertically), never an ancestor.
	useEffect(() => {
		const scroller = scrollerRef.current
		const mark = activeStart === null ? null : (scroller?.querySelector<HTMLElement>("[data-active-match]") ?? null)

		if (scroller === null || mark === null) {
			return
		}

		const gutter = mark.closest("[data-row]")?.firstElementChild?.getBoundingClientRect().width ?? 0
		const left = mark.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft - gutter
		const width = mark.getBoundingClientRect().width
		const room = scroller.clientWidth - gutter

		if (left < scroller.scrollLeft || left + width > scroller.scrollLeft + room) {
			scroller.scrollLeft = Math.max(0, left - Math.max(0, (room - width) / 2))
		}
	}, [activeStart, activeColumn, view.generation])

	const onWheel = useEffectEvent((event: WheelEvent) => {
		// A sideways scroll stays the browser's: the rows scroll horizontally on their own.
		if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
			return
		}

		event.preventDefault()
		scrollBy(event.deltaY * (event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? height : 1))
	})

	useEffect(() => {
		const scroller = scrollerRef.current

		if (scroller === null) {
			return
		}

		const listener = (event: WheelEvent): void => {
			onWheel(event)
		}
		const observer = new ResizeObserver(entries => {
			const measured = entries[0]?.contentRect.height

			if (measured !== undefined && measured > 0) setHeight(measured)
		})

		scroller.addEventListener("wheel", listener, { passive: false })
		observer.observe(scroller)

		return () => {
			scroller.removeEventListener("wheel", listener)
			observer.disconnect()
		}
	}, [])

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		const page = Math.max(rowHeight, height - rowHeight)
		const moves: Partial<Record<string, () => void>> = {
			ArrowDown: () => {
				scrollBy(rowHeight)
			},
			ArrowUp: () => {
				scrollBy(-rowHeight)
			},
			PageDown: () => {
				scrollBy(page)
			},
			PageUp: () => {
				scrollBy(-page)
			},
			Home: () => {
				void locate(start, 0, 1, false)
			},
			End: () => {
				void locate(size, shown, null, false)
			}
		}
		const move = event.altKey || event.shiftKey ? undefined : moves[event.key]

		if (move !== undefined && !event.defaultPrevented) {
			event.preventDefault()
			move()
		}
	}

	const onTouch = (event: PointerEvent<HTMLDivElement>): void => {
		if (event.pointerType !== "touch") {
			return
		}

		if (event.type === "pointerdown") {
			touch.current = event.clientY
		} else if (event.type === "pointermove" && touch.current !== null) {
			scrollBy(touch.current - event.clientY)
			touch.current = event.clientY
		} else {
			touch.current = null
		}
	}

	const fraction = drag ?? (size === 0 ? 0 : Math.min(1, at / size))
	const travel = Math.max(0, height - THUMB_PX)

	const onTrack = (event: PointerEvent<HTMLDivElement>): void => {
		const track = trackRef.current

		if (track === null) {
			return
		}

		const top = track.getBoundingClientRect().top
		const y = event.clientY - top

		if (event.type === "pointerdown") {
			const thumb = fraction * travel

			if (y >= thumb && y <= thumb + THUMB_PX) {
				grab.current = y - thumb
				track.setPointerCapture(event.pointerId)
			} else {
				scrollBy(y < thumb ? -(height - rowHeight) : height - rowHeight)
			}

			return
		}

		if (grab.current === null) {
			return
		}

		if (event.type === "pointermove") {
			const next = travel === 0 ? 0 : Math.min(1, Math.max(0, (y - grab.current) / travel))

			setDrag(next)
			seek(Math.round(next * size))
		} else {
			grab.current = null
			setDrag(null)
		}
	}

	const rows = view.rows.slice(view.top, view.top + shown)
	const numbered = rows.reduce((widest, row) => Math.max(widest, row.line ?? 0), 0)
	const gutter = `${String(Math.max(2, String(numbered).length + (numbered > 0 ? 1 : 0)))}ch`

	return (
		<div className="relative flex min-h-0 flex-1">
			<div
				ref={scrollerRef}
				role="document"
				aria-label={alt}
				tabIndex={0}
				className="min-h-0 flex-1 touch-pan-x overflow-x-auto overflow-y-hidden font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
				style={{ fontSize: `${String(fontSize)}px`, lineHeight: `${String(rowHeight)}px` }}
				onKeyDown={onKeyDown}
				onPointerDown={onTouch}
				onPointerMove={onTouch}
				onPointerUp={onTouch}
				onPointerCancel={onTouch}
			>
				<div
					className="w-max min-w-full"
					style={{ transform: `translateY(${String(-view.shift)}px)` }}
				>
					{rows.map(row => (
						<div
							key={row.start}
							data-row
							className="flex"
							style={{ height: `${String(rowHeight)}px` }}
						>
							<span
								className="sticky left-0 shrink-0 bg-background pr-3 pl-2 text-right text-muted-foreground tabular-nums select-none"
								style={{ width: `calc(${gutter} + 1.25rem)` }}
							>
								{row.continuation ? (
									<span
										role="img"
										aria-label={t("previewLargeTextContinuation")}
									>
										»
									</span>
								) : (
									row.line
								)}
							</span>
							<span className="pr-4 whitespace-pre">
								<RowText
									text={row.text}
									pattern={pattern}
									active={view.active !== null && view.active.start === row.start ? view.active.column : null}
								/>
							</span>
						</div>
					))}
				</div>
			</div>
			<div
				ref={trackRef}
				role="scrollbar"
				aria-label={t("previewLargeTextScrollbar")}
				aria-orientation="vertical"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(fraction * 100)}
				className="relative w-3 shrink-0 touch-none border-l border-border bg-muted/40"
				onPointerDown={onTrack}
				onPointerMove={onTrack}
				onPointerUp={onTrack}
				onPointerCancel={onTrack}
			>
				<div
					className="absolute inset-x-0.5 rounded-full bg-muted-foreground/40"
					style={{ top: `${String(fraction * travel)}px`, height: `${String(THUMB_PX)}px` }}
				/>
			</div>
		</div>
	)
}
