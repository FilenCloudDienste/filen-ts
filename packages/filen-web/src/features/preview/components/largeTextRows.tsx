import {
	useEffect,
	useEffectEvent,
	useId,
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
	numberRows,
	placedWindow,
	prependRows,
	scrollWindow,
	showsEnd,
	visibleRows,
	wantsAfter,
	wantsBefore,
	wholeRows,
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

// The thumb's height: a touch target of at least 44 px.
const THUMB_PX = 44
// A touch fling's speed (px/ms) loses this much each 16 ms frame, and stops below the second.
const FLING_DECAY = 0.95
const FLING_STOP = 0.02
const MATCH_CLASS = "rounded-[2px] bg-[color-mix(in_oklab,#facc15_35%,transparent)] text-inherit"
const ACTIVE_CLASS = "rounded-[2px] bg-[color-mix(in_oklab,#f97316_45%,transparent)] text-inherit"

// Matches marked at most, in a row and on the screen: a one-character query on long rows would otherwise mark thousands.
// The active match is always marked.
const ROW_MARKS = 200
const SCREEN_MARKS = 2000

// A row's text with its matches marked, at most `limit` of them besides the active one; and how many were.
function markedText(text: string, pattern: RegExp | null, active: number | null, limit: number): { parts: ReactNode; marks: number } {
	if (pattern === null || text === "") {
		return { parts: text, marks: 0 }
	}

	const parts: ReactNode[] = []
	let last = 0
	let marks = 0

	// matchAll runs on a copy of the pattern: the shared one is never touched.
	for (const match of text.matchAll(pattern)) {
		const isActive = match.index === active

		if (!isActive && marks >= limit) {
			if (active === null || active < match.index) break

			continue
		}

		if (match.index > last) parts.push(text.slice(last, match.index))

		parts.push(
			<mark
				key={match.index}
				className={isActive ? ACTIVE_CLASS : MATCH_CLASS}
				{...(isActive ? { "data-active-match": true } : {})}
			>
				{match[0]}
			</mark>
		)
		last = match.index + match[0].length
		marks++
	}

	parts.push(text.slice(last))

	return { parts, marks }
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
	// A touch drag's last point and its speed, then the fling it leaves behind.
	const touch = useRef<{ y: number; time: number; speed: number } | null>(null)
	const fling = useRef<number | null>(null)
	const scrollerId = useId()
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

	const stopFling = (): void => {
		if (fling.current !== null) {
			cancelAnimationFrame(fling.current)
			fling.current = null
		}
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

	// The rows held, numbered once lines are counted further: only their numbers change, never their cuts, so nothing
	// moves.
	const renumber = useEffectEvent(() => {
		const first = view.rows[0]
		const seq = view.generation

		if (first === undefined) {
			return
		}

		void pager
			.run(remote => remote.lineOf(first.start))
			.then(
				({ line, frontier }) => {
					setView(previous =>
						previous.generation === seq && previous.rows[0]?.start === first.start
							? { ...previous, rows: numberRows(previous.rows, line, frontier) }
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

		if (first !== undefined) position.set(showsEnd(current, bounds) ? size : first.start)
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
		// Ctrl with the wheel (a trackpad pinch) is the browser's zoom; a sideways scroll stays the browser's too: the rows
		// scroll horizontally on their own.
		if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
			return
		}

		const pixels = event.deltaY * (event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? height : 1)

		event.preventDefault()
		stopFling()

		// Shift with the wheel scrolls sideways where the browser reports it as vertical.
		if (event.shiftKey) {
			const scroller = scrollerRef.current

			if (scroller !== null) scroller.scrollLeft += pixels

			return
		}

		scrollBy(pixels)
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
				// The last row at the view's bottom: as many above it as fill the view.
				void locate(size, wholeRows(bounds) - 1, null, false)
			}
		}
		const move = event.altKey || event.shiftKey ? undefined : moves[event.key]

		if (move !== undefined && !event.defaultPrevented) {
			event.preventDefault()
			stopFling()
			move()
		}
	}

	// Carries a released touch drag on at its speed, slowing each frame.
	const startFling = (speed: number): void => {
		let velocity = speed
		let last = performance.now()
		const frame = (now: number): void => {
			const elapsed = Math.max(1, now - last)

			last = now
			scrollBy(velocity * elapsed)
			velocity *= FLING_DECAY ** (elapsed / 16)
			fling.current = Math.abs(velocity) < FLING_STOP ? null : requestAnimationFrame(frame)
		}

		stopFling()
		fling.current = Math.abs(velocity) < FLING_STOP ? null : requestAnimationFrame(frame)
	}

	useEffect(() => stopFling, [])

	const onTouch = (event: PointerEvent<HTMLDivElement>): void => {
		if (event.pointerType !== "touch") {
			return
		}

		const now = performance.now()
		const last = touch.current

		if (event.type === "pointerdown") {
			stopFling()
			touch.current = { y: event.clientY, time: now, speed: 0 }
		} else if (event.type === "pointermove" && last !== null) {
			const delta = last.y - event.clientY
			const elapsed = Math.max(1, now - last.time)

			scrollBy(delta)
			// Smoothed over the last moves, so one jittery sample does not set the fling.
			touch.current = { y: event.clientY, time: now, speed: last.speed * 0.2 + (delta / elapsed) * 0.8 }
		} else {
			touch.current = null

			// A drag that ended moving flings; one that paused first does not.
			if (event.type === "pointerup" && last !== null && now - last.time < 100) startFling(last.speed)
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
	const texts: ReactNode[] = []
	let marksLeft = SCREEN_MARKS

	for (const row of rows) {
		const marked = markedText(
			row.text,
			pattern,
			view.active !== null && view.active.start === row.start ? view.active.column : null,
			Math.min(ROW_MARKS, marksLeft)
		)

		marksLeft = Math.max(0, marksLeft - marked.marks)
		texts.push(marked.parts)
	}
	const numbered = rows.reduce((widest, row) => Math.max(widest, row.line ?? 0), 0)
	const gutter = `${String(Math.max(2, String(numbered).length + (numbered > 0 ? 1 : 0)))}ch`

	return (
		<div className="relative flex min-h-0 flex-1">
			<div
				ref={scrollerRef}
				id={scrollerId}
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
					{rows.map((row, index) => (
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
							<span className="pr-4 whitespace-pre">{texts[index]}</span>
						</div>
					))}
				</div>
			</div>
			<div
				ref={trackRef}
				role="scrollbar"
				tabIndex={0}
				aria-label={t("previewLargeTextScrollbar")}
				aria-controls={scrollerId}
				aria-orientation="vertical"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(fraction * 100)}
				className="relative w-3 shrink-0 touch-none border-l border-border bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
				onKeyDown={onKeyDown}
				onPointerDown={onTrack}
				onPointerMove={onTrack}
				onPointerUp={onTrack}
				onPointerCancel={onTrack}
			>
				{/* A finger's target: 44 px wide, reaching over the rows' edge. */}
				<div
					aria-hidden="true"
					className="absolute inset-y-0 right-0 hidden w-11 pointer-coarse:block"
				/>
				<div
					className="absolute inset-x-0.5 rounded-full bg-muted-foreground/40"
					style={{ top: `${String(fraction * travel)}px`, height: `${String(THUMB_PX)}px` }}
				/>
			</div>
		</div>
	)
}
