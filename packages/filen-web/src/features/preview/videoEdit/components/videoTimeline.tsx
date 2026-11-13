import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import type { TimeRange, VideoEditClient } from "@/features/preview/videoEdit/types"
import { edgeBounds, MIN_KEEP_SECONDS, removedRanges, type KeepEdge } from "@/features/preview/videoEdit/lib/recipe"
import {
	filmstripSlots,
	formatTimecode,
	pinchFactor,
	panView,
	rulerStep,
	rulerTicks,
	sliderKeyTarget,
	timeToX,
	viewSpan,
	wheelZoomFactor,
	xToTime,
	zoomView,
	type SnapMark,
	type TimelineView
} from "@/features/preview/videoEdit/lib/timeline.logic"
import type { EditorPlayback } from "@/features/preview/videoEdit/components/editorPlayback"
import { ThumbnailCache } from "@/features/preview/videoEdit/components/thumbnailCache"
import { log } from "@/lib/log"
import { useLatestRef } from "@/lib/useLatestRef"

// Heights in CSS px of the timeline's lanes.
const RULER_HEIGHT = 18
const FILMSTRIP_HEIGHT = 52
const WAVEFORM_HEIGHT = 28
// A filmstrip tile's width at its height (16:9).
const TILE_WIDTH = Math.round((FILMSTRIP_HEIGHT * 16) / 9)
// Ruler labels at least this far apart.
const RULER_GAP = 72
// A press that moves less than this is a click (seek), more a selection drag.
const DRAG_SLOP = 4
// Fetches wait this long after the view settles: a zoom or pan gesture asks once, at its end.
const FETCH_DELAY_MS = 120
const THUMBNAIL_CAPACITY = 240

const HATCH_STYLE = {
	backgroundImage: "repeating-linear-gradient(135deg, rgb(0 0 0 / 0.6) 0 6px, rgb(255 255 255 / 0.07) 6px 12px)"
}

export interface VideoTimelineProps {
	client: VideoEditClient
	playback: EditorPlayback
	duration: number
	fps: number
	keep: readonly TimeRange[]
	view: TimelineView
	selection: TimeRange | null
	splits: readonly number[]
	// Edges the fast save moves to a key frame (empty when cuts are precise).
	snaps: readonly SnapMark[]
	locked: boolean
	onView: (view: TimelineView) => void
	onSeek: (time: number) => void
	onSelect: (range: TimeRange | null) => void
	// A trim handle let go (or nudged from the keyboard, coalesced by `coalesceKey`).
	onEdge: (index: number, edge: KeepEdge, time: number, coalesceKey: string | undefined) => void
	// A trim handle dragged to `time`: the stage shows that exact frame, and draws it into the loupe too.
	onScrub: (time: number) => void
	onLoupeCanvas: (canvas: HTMLCanvasElement | null) => void
	onMakePrecise: () => void
}

interface HandleDrag {
	index: number
	edge: KeepEdge
	bounds: TimeRange
	left: number
	width: number
	element: HTMLElement
	time: number
}

interface TrackPress {
	pointerId: number
	x: number
	left: number
	width: number
	moved: boolean
}

interface Pinch {
	distance: number
	view: TimelineView
	anchor: number
}

function rulerLabel(time: number, step: number): string {
	const code = formatTimecode(time)

	// Whole-second steps read without the hundredths.
	return step >= 1 ? code.slice(0, code.lastIndexOf(".")) : code
}

// The part of the timeline between split points (and kept-range edges) that `time` falls in, when a split bounds it.
function segmentAt(keep: readonly TimeRange[], splits: readonly number[], time: number): TimeRange | null {
	const range = keep.find(current => time >= current.start && time < current.end)

	if (range === undefined) {
		return null
	}

	const before = splits.filter(split => split > range.start && split <= time)
	const after = splits.filter(split => split < range.end && split > time)
	const start = before.length > 0 ? Math.max(...before) : range.start
	const end = after.length > 0 ? Math.min(...after) : range.end

	return before.length === 0 && after.length === 0 ? null : { start, end }
}

// The timeline under the stage: a ruler, the filmstrip and the waveform (both drawn to canvases from what the client
// returns, fetched for the visible window only), removed sections hatched, the selection, trim handles at every kept
// part's ends (sliders, frame by frame from the keyboard), the playhead (moved by the playback's ticks, never by a
// render), and, where the fast save snaps a cut to a key frame, a dashed ghost at the real edge with a chip offering
// to make it precise. Ctrl/Cmd+wheel and pinch zoom it; the wheel pans it while zoomed.
export function VideoTimeline(props: VideoTimelineProps) {
	const { t } = useTranslation("preview")
	const trackRef = useRef<HTMLDivElement | null>(null)
	const filmstripRef = useRef<HTMLCanvasElement | null>(null)
	const waveformRef = useRef<HTMLCanvasElement | null>(null)
	const playheadRef = useRef<HTMLDivElement | null>(null)
	const selectionDraftRef = useRef<HTMLDivElement | null>(null)
	const loupeRef = useRef<HTMLDivElement | null>(null)
	const loupeTimeRef = useRef<HTMLSpanElement | null>(null)
	const [width, setWidth] = useState(0)
	const [cache] = useState(() => new ThumbnailCache(THUMBNAIL_CAPACITY))
	const handleDrag = useRef<HandleDrag | null>(null)
	const press = useRef<TrackPress | null>(null)
	const pointers = useRef(new Map<number, { x: number }>())
	const pinch = useRef<Pinch | null>(null)
	const { view, duration, client, onLoupeCanvas } = props
	const span = viewSpan(view)

	// The track's width, the one layout figure everything here is drawn against.
	useEffect(() => {
		const track = trackRef.current

		if (track === null) {
			return
		}

		const observer = new ResizeObserver(entries => {
			const entry = entries[entries.length - 1]

			if (entry !== undefined) {
				setWidth(Math.round(entry.contentRect.width))
			}
		})

		observer.observe(track)

		return () => {
			observer.disconnect()
		}
	}, [])

	useEffect(() => {
		return () => {
			cache.clear()
		}
	}, [cache])

	// The playhead and its time follow the playback's ticks directly.
	useEffect(() => {
		const move = (time: number): void => {
			const head = playheadRef.current

			if (head !== null) {
				const x = timeToX(view, width, time)

				head.style.transform = `translateX(${String(x)}px)`
				head.style.visibility = x < -1 || x > width + 1 ? "hidden" : "visible"
			}
		}

		move(props.playback.time)

		return props.playback.subscribe(move)
	}, [props.playback, view, width])

	// The filmstrip: tiles from the cache drawn at once, the missing ones fetched once the view settles. A view that
	// moved on meanwhile still keeps what came back (the cache), drawing only the current slots.
	useEffect(() => {
		const canvas = filmstripRef.current

		if (canvas === null || width <= 0) {
			return
		}

		const ratio = window.devicePixelRatio
		const slots = filmstripSlots(view, width, TILE_WIDTH, duration)
		let alive = true

		const draw = (): void => {
			const context = canvas.getContext("2d")

			if (context === null) {
				return
			}

			canvas.width = Math.round(width * ratio)
			canvas.height = Math.round(FILMSTRIP_HEIGHT * ratio)
			context.fillStyle = "rgb(255 255 255 / 0.06)"
			context.fillRect(0, 0, canvas.width, canvas.height)

			for (const time of slots.times) {
				const start = time - slots.step / 2
				const x = timeToX(view, width, start) * ratio
				const tileWidth = (slots.step / viewSpan(view)) * width * ratio
				const bitmap = cache.get(ThumbnailCache.key(slots.step, time))

				if (bitmap === undefined || bitmap.width === 0) {
					continue
				}

				// Cover the tile, centred.
				const scale = Math.max(tileWidth / bitmap.width, canvas.height / bitmap.height)
				const sw = tileWidth / scale
				const sh = canvas.height / scale

				context.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, x, 0, tileWidth, canvas.height)
			}
		}

		draw()

		const missing = slots.times.filter(time => !cache.has(ThumbnailCache.key(slots.step, time)))

		if (missing.length === 0) {
			return () => {
				alive = false
			}
		}

		const timer = window.setTimeout(() => {
			client.filmstrip(missing, Math.round(FILMSTRIP_HEIGHT * ratio)).then(
				tiles => {
					for (const tile of tiles) {
						cache.set(ThumbnailCache.key(slots.step, tile.time), tile.bitmap)
					}

					if (alive) {
						draw()
					}
				},
				(error: unknown) => {
					log.warn("[videoEditor] filmstrip failed", error)
				}
			)
		}, FETCH_DELAY_MS)

		return () => {
			alive = false
			window.clearTimeout(timer)
		}
	}, [client, cache, view, width, duration])

	// The waveform: peaks for the visible window from what is already fetched, redrawn as more arrives.
	useEffect(() => {
		const canvas = waveformRef.current

		if (canvas === null || width <= 0) {
			return
		}

		const ratio = window.devicePixelRatio
		const columns = Math.max(1, Math.floor(width / 2))
		let stop: (() => void) | null = null

		const draw = (peaks: Float32Array): void => {
			const context = canvas.getContext("2d")

			if (context === null) {
				return
			}

			canvas.width = Math.round(width * ratio)
			canvas.height = Math.round(WAVEFORM_HEIGHT * ratio)

			const middle = canvas.height / 2
			const column = canvas.width / peaks.length

			for (let index = 0; index < peaks.length; index++) {
				const peak = peaks[index] ?? Number.NaN
				const x = index * column

				// No data yet: a faint dot on the centre line.
				if (Number.isNaN(peak)) {
					context.fillStyle = "rgb(255 255 255 / 0.15)"
					context.fillRect(x, middle - ratio / 2, Math.max(1, column / 2), ratio)
					continue
				}

				const height = Math.max(ratio, peak * canvas.height)

				context.fillStyle = "rgb(125 211 252 / 0.85)"
				context.fillRect(x, middle - height / 2, Math.max(1, column - ratio / 2), height)
			}
		}

		const timer = window.setTimeout(() => {
			stop = client.waveform(view, columns, draw)
		}, FETCH_DELAY_MS)

		return () => {
			window.clearTimeout(timer)
			stop?.()
		}
	}, [client, view, width])

	const latest = useLatestRef({ view, duration, onView: props.onView })

	// Ctrl/Cmd+wheel zooms about the pointer; the wheel pans while zoomed. Not passive: the page must not zoom or scroll.
	useEffect(() => {
		const track = trackRef.current

		if (track === null) {
			return
		}

		const listener = (event: WheelEvent): void => {
			const current = latest.current
			const box = track.getBoundingClientRect()

			if (event.ctrlKey || event.metaKey) {
				event.preventDefault()
				current.onView(
					zoomView(
						current.view,
						wheelZoomFactor(event.deltaY, event.deltaMode),
						xToTime(current.view, box.width, event.clientX - box.left),
						current.duration
					)
				)

				return
			}

			const delta = event.shiftKey ? event.deltaY : event.deltaX

			if (Math.abs(delta) > 0 && viewSpan(current.view) < current.duration) {
				event.preventDefault()
				current.onView(panView(current.view, (delta / Math.max(1, box.width)) * viewSpan(current.view), current.duration))
			}
		}

		track.addEventListener("wheel", listener, { passive: false })

		return () => {
			track.removeEventListener("wheel", listener)
		}
	}, [latest])

	const timeAtClient = (clientX: number, left: number, trackWidth: number): number =>
		Math.min(duration, Math.max(0, xToTime(view, trackWidth, clientX - left)))

	// ---- Trim handles. ----

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, index: number, edge: KeepEdge): void => {
		const track = trackRef.current

		if (event.button !== 0 || props.locked || track === null) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		event.currentTarget.setPointerCapture(event.pointerId)
		event.currentTarget.focus()

		const box = track.getBoundingClientRect()
		const range = props.keep[index]

		handleDrag.current = {
			index,
			edge,
			bounds: edgeBounds(props.keep, index, edge, duration),
			left: box.left,
			width: box.width,
			element: event.currentTarget,
			time: range === undefined ? 0 : edge === "start" ? range.start : range.end
		}
	}

	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const drag = handleDrag.current

		if (drag === null) {
			return
		}

		const time = Math.min(drag.bounds.end, Math.max(drag.bounds.start, timeAtClient(event.clientX, drag.left, drag.width)))
		const x = timeToX(view, drag.width, time)

		drag.time = time
		drag.element.style.left = `${String(x)}px`

		const loupe = loupeRef.current

		if (loupe !== null) {
			loupe.style.left = `${String(Math.min(drag.width - 80, Math.max(80, x)))}px`
			loupe.hidden = false
		}

		if (loupeTimeRef.current !== null) {
			loupeTimeRef.current.textContent = formatTimecode(time)
		}

		props.onScrub(time)
	}

	const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean): void => {
		const drag = handleDrag.current

		if (drag === null) {
			return
		}

		handleDrag.current = null

		if (loupeRef.current !== null) {
			loupeRef.current.hidden = true
		}

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}

		const range = props.keep[drag.index]
		const before = range === undefined ? drag.time : drag.edge === "start" ? range.start : range.end

		if (commit && drag.time !== before) {
			props.onEdge(drag.index, drag.edge, drag.time, undefined)
		} else {
			drag.element.style.left = `${String(timeToX(view, drag.width, before))}px`
		}
	}

	const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>, index: number, edge: KeepEdge): void => {
		const range = props.keep[index]

		if (range === undefined || props.locked) {
			return
		}

		const value = edge === "start" ? range.start : range.end
		const next = sliderKeyTarget(event.key, event.shiftKey, value, edgeBounds(props.keep, index, edge, duration), props.fps)

		if (next === null) {
			return
		}

		// The handle's own: the editor's arrows step the playhead.
		event.preventDefault()
		event.stopPropagation()

		if (next !== value) {
			props.onEdge(index, edge, next, `edge-${String(index)}-${edge}`)
			props.onSeek(next)
		}
	}

	// ---- The track: click to seek (selecting a split part), drag to select, pinch to zoom. ----

	const trackPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const track = trackRef.current

		if (track === null || props.locked || (event.pointerType === "mouse" && event.button !== 0)) {
			return
		}

		pointers.current.set(event.pointerId, { x: event.clientX })
		event.currentTarget.setPointerCapture(event.pointerId)

		const box = track.getBoundingClientRect()

		if (pointers.current.size === 2) {
			// A second finger: the press becomes a pinch.
			press.current = null

			const [a, b] = [...pointers.current.values()]

			if (a !== undefined && b !== undefined) {
				pinch.current = {
					distance: Math.abs(a.x - b.x),
					view,
					anchor: timeAtClient((a.x + b.x) / 2, box.left, box.width)
				}
			}

			if (selectionDraftRef.current !== null) {
				selectionDraftRef.current.hidden = true
			}

			return
		}

		press.current = { pointerId: event.pointerId, x: event.clientX, left: box.left, width: box.width, moved: false }
	}

	const trackPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (pointers.current.has(event.pointerId)) {
			pointers.current.set(event.pointerId, { x: event.clientX })
		}

		const pinching = pinch.current

		if (pinching !== null) {
			const [a, b] = [...pointers.current.values()]

			if (a !== undefined && b !== undefined) {
				props.onView(zoomView(pinching.view, pinchFactor(pinching.distance, Math.abs(a.x - b.x)), pinching.anchor, duration))
			}

			return
		}

		const current = press.current

		if (current?.pointerId !== event.pointerId) {
			return
		}

		if (!current.moved && Math.abs(event.clientX - current.x) < DRAG_SLOP) {
			return
		}

		current.moved = true

		const draft = selectionDraftRef.current

		if (draft !== null) {
			const from = Math.min(current.x, event.clientX) - current.left
			const to = Math.max(current.x, event.clientX) - current.left

			draft.hidden = false
			draft.style.left = `${String(Math.max(0, from))}px`
			draft.style.width = `${String(Math.min(current.width, to) - Math.max(0, from))}px`
		}
	}

	const trackPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
		pointers.current.delete(event.pointerId)

		if (pinch.current !== null) {
			if (pointers.current.size === 0) {
				pinch.current = null
			}

			return
		}

		const current = press.current

		press.current = null

		if (selectionDraftRef.current !== null) {
			selectionDraftRef.current.hidden = true
		}

		if (current?.pointerId !== event.pointerId) {
			return
		}

		const time = timeAtClient(event.clientX, current.left, current.width)

		if (current.moved) {
			const start = Math.min(time, timeAtClient(current.x, current.left, current.width))
			const end = Math.max(time, timeAtClient(current.x, current.left, current.width))

			props.onSelect(end - start >= MIN_KEEP_SECONDS ? { start, end } : null)

			return
		}

		props.onSelect(segmentAt(props.keep, props.splits, time))
		props.onSeek(time)
	}

	const trackPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
		pointers.current.delete(event.pointerId)
		press.current = null
		pinch.current = pointers.current.size >= 2 ? pinch.current : null

		if (selectionDraftRef.current !== null) {
			selectionDraftRef.current.hidden = true
		}
	}

	const x = (time: number): number => timeToX(view, width, time)
	const step = rulerStep(view, width, RULER_GAP)
	const ticks = width > 0 ? rulerTicks(view, width, RULER_GAP) : []
	const removed = removedRanges(props.keep, duration).filter(range => range.end > view.start && range.start < view.end)
	const chips = props.snaps.filter(mark => mark.chip && mark.actual >= view.start && mark.actual <= view.end)
	const lanesHeight = RULER_HEIGHT + FILMSTRIP_HEIGHT + WAVEFORM_HEIGHT

	return (
		<div className="relative flex flex-col gap-1">
			{chips.length > 0 ? (
				<div className="relative h-7">
					{chips.map(mark => (
						<div
							key={mark.requested}
							className="absolute top-0 flex -translate-x-1/2 items-center gap-1 rounded-full bg-popover/90 py-0.5 pr-0.5 pl-2.5 text-[11px] whitespace-nowrap text-popover-foreground shadow-sm ring-1 ring-border"
							style={{ left: Math.min(width - 90, Math.max(90, x(mark.actual))) }}
						>
							<span>
								{t(mark.delta > 0 ? "previewVideoEditSnapsLater" : "previewVideoEditSnapsEarlier", {
									seconds: Math.abs(mark.delta).toFixed(1)
								})}
							</span>
							<button
								type="button"
								disabled={props.locked}
								className="rounded-full px-2 py-0.5 font-medium text-primary outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
								onClick={props.onMakePrecise}
							>
								{t("previewVideoEditMakePrecise")}
							</button>
						</div>
					))}
				</div>
			) : null}
			<div
				ref={trackRef}
				role="group"
				aria-label={t("previewVideoEditTimeline")}
				className="relative touch-none overflow-hidden rounded-xl bg-black/40 select-none"
				style={{ height: lanesHeight }}
				onPointerDown={trackPointerDown}
				onPointerMove={trackPointerMove}
				onPointerUp={trackPointerUp}
				onPointerCancel={trackPointerCancel}
			>
				{/* Ruler. */}
				<div
					aria-hidden="true"
					className="absolute inset-x-0 top-0 border-b border-white/10"
					style={{ height: RULER_HEIGHT }}
				>
					{ticks.map(tick => (
						<span
							key={tick}
							className="absolute top-0 flex h-full items-end border-l border-white/25 pb-0.5 pl-1 text-[10px] leading-none text-white/60 tabular-nums"
							style={{ left: x(tick) }}
						>
							{rulerLabel(tick, step)}
						</span>
					))}
				</div>
				<canvas
					ref={filmstripRef}
					aria-hidden="true"
					className="absolute inset-x-0 block w-full"
					style={{ top: RULER_HEIGHT, height: FILMSTRIP_HEIGHT }}
				/>
				<canvas
					ref={waveformRef}
					aria-hidden="true"
					className="absolute inset-x-0 block w-full"
					style={{ top: RULER_HEIGHT + FILMSTRIP_HEIGHT, height: WAVEFORM_HEIGHT }}
				/>
				{/* Removed sections, hatched and dimmed. */}
				{removed.map(range => (
					<div
						key={`${String(range.start)}-${String(range.end)}`}
						role="img"
						aria-label={t("previewVideoEditRemovedRange", {
							start: formatTimecode(range.start),
							end: formatTimecode(range.end)
						})}
						className="pointer-events-none absolute bg-black/45"
						style={{
							...HATCH_STYLE,
							top: RULER_HEIGHT,
							bottom: 0,
							left: Math.max(0, x(range.start)),
							width: Math.max(1, Math.min(width, x(range.end)) - Math.max(0, x(range.start)))
						}}
					/>
				))}
				{props.selection !== null ? (
					<div
						role="img"
						aria-label={t("previewVideoEditSelectionRange", {
							start: formatTimecode(props.selection.start),
							end: formatTimecode(props.selection.end)
						})}
						className="pointer-events-none absolute border-x-2 border-primary bg-primary/25"
						style={{
							top: RULER_HEIGHT,
							bottom: 0,
							left: x(props.selection.start),
							width: Math.max(2, x(props.selection.end) - x(props.selection.start))
						}}
					/>
				) : null}
				<div
					ref={selectionDraftRef}
					hidden
					aria-hidden="true"
					className="pointer-events-none absolute border-x-2 border-primary/80 bg-primary/20"
					style={{ top: RULER_HEIGHT, bottom: 0 }}
				/>
				{props.splits
					.filter(split => split >= view.start && split <= view.end)
					.map(split => (
						<span
							key={split}
							aria-hidden="true"
							className="pointer-events-none absolute w-0.5 -translate-x-1/2 bg-white/80"
							style={{ top: RULER_HEIGHT, bottom: 0, left: x(split) }}
						/>
					))}
				{/* Where the fast save really cuts. */}
				{props.snaps
					.filter(mark => mark.actual >= view.start && mark.actual <= view.end)
					.map(mark => (
						<span
							key={mark.requested}
							aria-hidden="true"
							data-snap-ghost=""
							className="pointer-events-none absolute w-0 -translate-x-px border-l-2 border-dashed border-amber-300/90"
							style={{ top: 0, bottom: 0, left: x(mark.actual) }}
						/>
					))}
				{props.keep.flatMap((range, index) =>
					(["start", "end"] as const).map(edge => (
						<TrimHandle
							key={`${String(index)}-${edge}`}
							index={index}
							edge={edge}
							value={edge === "start" ? range.start : range.end}
							bounds={edgeBounds(props.keep, index, edge, duration)}
							x={x(edge === "start" ? range.start : range.end)}
							offscreen={
								(edge === "start" ? range.start : range.end) < view.start - span * 0.02 ||
								(edge === "start" ? range.start : range.end) > view.end + span * 0.02
							}
							locked={props.locked}
							onPointerDown={handlePointerDown}
							onPointerMove={handlePointerMove}
							onPointerEnd={handlePointerEnd}
							onKey={handleKey}
						/>
					))
				)}
				<div
					ref={playheadRef}
					aria-hidden="true"
					className="pointer-events-none absolute top-0 bottom-0 left-0 z-20 w-0.5 -translate-x-px bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)] will-change-transform"
				>
					<span className="absolute -top-px left-1/2 size-2.5 -translate-x-1/2 rotate-45 bg-white" />
				</div>
			</div>
			{/* The loupe over a dragged handle: the exact frame there and its time, bigger than a finger. */}
			<div
				ref={loupeRef}
				hidden
				aria-hidden="true"
				className="absolute bottom-full z-30 mb-2 w-40 -translate-x-1/2 overflow-hidden rounded-xl bg-black shadow-xl ring-1 ring-white/30"
			>
				<canvas
					ref={onLoupeCanvas}
					className="block aspect-video w-full object-contain"
				/>
				<span
					ref={loupeTimeRef}
					className="block py-0.5 text-center text-[11px] text-white tabular-nums"
				/>
			</div>
		</div>
	)
}

// A trim handle: a slider over one end of a kept part, its time read out as a timecode.
function TrimHandle(props: {
	index: number
	edge: KeepEdge
	value: number
	bounds: TimeRange
	x: number
	offscreen: boolean
	locked: boolean
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, index: number, edge: KeepEdge) => void
	onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
	onPointerEnd: (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => void
	onKey: (event: ReactKeyboardEvent<HTMLDivElement>, index: number, edge: KeepEdge) => void
}) {
	const { t } = useTranslation("preview")
	const label = t(props.edge === "start" ? "previewVideoEditHandleStart" : "previewVideoEditHandleEnd", { number: props.index + 1 })

	return (
		<div
			role="slider"
			tabIndex={props.locked ? -1 : 0}
			aria-label={label}
			aria-orientation="horizontal"
			aria-valuemin={props.bounds.start}
			aria-valuemax={props.bounds.end}
			aria-valuenow={props.value}
			aria-valuetext={formatTimecode(props.value)}
			aria-disabled={props.locked}
			data-trim-handle={props.edge}
			className={cn(
				"group/handle absolute top-0 bottom-0 z-10 w-11 -translate-x-1/2 cursor-ew-resize touch-none outline-none",
				props.offscreen && "hidden"
			)}
			style={{ left: props.x }}
			onPointerDown={event => {
				props.onPointerDown(event, props.index, props.edge)
			}}
			onPointerMove={event => {
				props.onPointerMove(event)
			}}
			onPointerUp={event => {
				props.onPointerEnd(event, true)
			}}
			onPointerCancel={event => {
				props.onPointerEnd(event, false)
			}}
			onKeyDown={event => {
				props.onKey(event, props.index, props.edge)
			}}
		>
			<span
				className={cn(
					"pointer-events-none absolute w-2.5 rounded-sm bg-amber-400 shadow-md ring-1 ring-black/40 group-focus-visible/handle:ring-2 group-focus-visible/handle:ring-white",
					props.edge === "start" ? "left-1/2 rounded-l-md" : "right-1/2 rounded-r-md"
				)}
				style={{ top: RULER_HEIGHT, bottom: 0 }}
			/>
		</div>
	)
}
